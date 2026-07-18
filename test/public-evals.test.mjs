import { describe, expect, it } from "vitest";
import {
  DISCOVERY_PROBE_IDS_V1,
  GOVERNED_PROBE_IDS,
  runPublicEvals,
} from "../lib/public-evals.mjs";
import { validMutationOpenApi } from "./fixtures/openapi.mjs";

const BASE_URL = "https://implementation.example";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(value, status = 200) {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function anonymousTarget({
  governed = false,
  whoamiData,
  launchFailure = false,
  emptyNextActionsStage,
  missingTaskIdStage,
  omitGovernedField,
  openApiDocument,
} = {}) {
  const requests = [];
  let serviceLive = false;
  let teardownCount = 0;

  function mutatingEnvelope(stage, data, action, nextActions) {
    const envelope = {
      data: {
        ...data,
        receipt: {
          action,
          oneTimeUsd: 0,
          monthlyDeltaUsd: 0,
          resources: [],
        },
        undo: { command: `undo ${action}`, irreversible: false },
        budgetRemainingUsd: 25,
      },
      nextActions,
    };
    if (omitGovernedField?.stage === stage) {
      if (omitGovernedField.field === "nextActions") {
        delete envelope.nextActions;
      } else {
        delete envelope.data[omitGovernedField.field];
      }
    }
    if (emptyNextActionsStage === stage) envelope.nextActions = [];
    return envelope;
  }

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    requests.push({ url, init, headers });
    if (url.pathname === "/llms.txt") return text("# SproutPad");
    if (url.pathname === "/.well-known/mcp.json") {
      return json({ url: `${BASE_URL}/mcp` });
    }
    if (url.pathname === "/openapi.json") {
      return json(openApiDocument ?? validMutationOpenApi());
    }
    if (url.pathname === "/agents.md") return text("# agents guide");
    if (url.pathname === "/spec.md") return text("# Governed Agent Spend");
    if (url.pathname === "/transparency") {
      return json({ data: { governance: {} } });
    }
    if (url.pathname === "/v1/domains/search") {
      return json({ data: { results: [] } });
    }
    if (governed && url.pathname === "/v1/whoami") {
      return json({
        data: whoamiData ?? {
          authenticated: true,
          rung: 1,
          scopes: ["teardown", "read", "provision"],
          projects: [
            {
              id: "prj_dedicated",
              environment: "scratch",
              budgetCapUsd: 25,
            },
          ],
        },
      });
    }
    if (url.pathname === "/v1/quotes") {
      if (headers.has("authorization")) {
        return json(
          mutatingEnvelope(
            "quote",
            { verdict: "ALLOW" },
            "reserve_quote_budget",
            ["launch_service"],
          ),
        );
      }
      return json({ blockedBy: "auth:required" }, 401);
    }
    if (
      governed &&
      url.pathname === "/v1/projects/prj_dedicated/teardown" &&
      init.method === "POST"
    ) {
      teardownCount += 1;
      serviceLive = false;
      const stage = teardownCount === 1 ? "reset" : "teardown";
      return json(
        mutatingEnvelope(
          stage,
          missingTaskIdStage === stage
            ? {}
            : { taskId: `tsk_teardown_${teardownCount}` },
          stage === "reset" ? "reset_scratch_project" : "teardown_project",
          [`GET /v1/tasks/tsk_teardown_${teardownCount}`],
        ),
        202,
      );
    }
    if (governed && url.pathname === "/v1/projects/prj_dedicated/resources") {
      return json({
        data: {
          resources: [],
          services: serviceLive ? [{ name: "evalweb", status: "live" }] : [],
          parkedDomains: [],
        },
      });
    }
    if (
      governed &&
      url.pathname === "/v1/projects/prj_dedicated/launch" &&
      init.method === "POST"
    ) {
      if (launchFailure) {
        return json({ blockedBy: "provider:launch_failed" }, 503);
      }
      serviceLive = true;
      return json(
        mutatingEnvelope(
          "launch",
          missingTaskIdStage === "launch" ? {} : { taskId: "tsk_launch" },
          "launch_service",
          ["GET /v1/tasks/tsk_launch"],
        ),
        202,
      );
    }
    if (governed && url.pathname === "/v1/projects/prj_dedicated/status") {
      const envelope = {
        data: {
          services: serviceLive ? [{ name: "evalweb", status: "live" }] : [],
        },
        nextActions: ["get_costs"],
      };
      if (
        omitGovernedField?.stage === "status" &&
        omitGovernedField.field === "nextActions"
      ) {
        delete envelope.nextActions;
      }
      return json(envelope);
    }
    if (governed && url.pathname.startsWith("/v1/tasks/tsk_")) {
      return json({ data: { status: "completed" } });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  return { fetchImpl, requests };
}

describe("public discovery and governed evaluator", () => {
  it("keeps discovery anonymous even when a partial credential is present", async () => {
    const target = anonymousTarget();
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      agentKey: "agk_never_send.secret",
      includeMcpContract: false,
    });

    expect(
      result.scenarios
        .filter((scenario) => !scenario.id.startsWith("loop."))
        .map((scenario) => scenario.id),
    ).toEqual(DISCOVERY_PROBE_IDS_V1);
    expect(
      result.scenarios
        .filter((scenario) => GOVERNED_PROBE_IDS.includes(scenario.id))
        .every((scenario) => scenario.status === "not_run"),
    ).toBe(true);
    for (const request of target.requests) {
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.init.redirect).toBe("error");
      expect(request.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("fails discovery when OpenAPI omits the universal mutation contract", async () => {
    const openApiDocument = validMutationOpenApi();
    delete openApiDocument.paths["/v1/projects"].post[
      "x-sproutpad-operation-class"
    ];
    const target = anonymousTarget({ openApiDocument });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      includeMcpContract: false,
    });

    expect(
      result.scenarios.find((scenario) => scenario.id === "discovery.openapi"),
    ).toMatchObject({
      status: "fail",
      error: expect.stringContaining("mutation inventory mismatch"),
    });
  });

  it("fails discovery when OpenAPI weakens the canonical top-level mutation shape", async () => {
    const openApiDocument = validMutationOpenApi();
    const branch =
      openApiDocument.components.schemas.MutatingSuccessEnvelope.allOf[1];
    delete branch.additionalProperties;
    const target = anonymousTarget({ openApiDocument });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      includeMcpContract: false,
    });

    expect(
      result.scenarios.find((scenario) => scenario.id === "discovery.openapi"),
    ).toMatchObject({
      status: "fail",
      error: expect.stringContaining("strictly combine"),
    });
  });

  it("redacts the governed bearer secret from every recorded failure", async () => {
    const agentKey = "agk_highly_sensitive.secret";
    const requestHeaders = [];
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      agentKey,
      projectId: "prj_dedicated",
      includeMcpContract: false,
      pollIntervalMs: 1,
      fetchImpl: async (_input, init = {}) => {
        requestHeaders.push(new Headers(init.headers));
        throw new Error(
          `Bearer ${agentKey} {"authorizationHeader":"${agentKey}"}`,
        );
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(agentKey);
    expect(serialized).toContain("[redacted]");
    expect(
      requestHeaders.every((headers) => !headers.has("authorization")),
    ).toBe(true);
    expect(
      result.scenarios
        .filter((scenario) => GOVERNED_PROBE_IDS.includes(scenario.id))
        .every((scenario) => scenario.status === "fail"),
    ).toBe(true);
  });

  it("runs the guarded lifecycle with authorization only on governed calls", async () => {
    const target = anonymousTarget({ governed: true });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      agentKey: "agk_dedicated.secret",
      projectId: "prj_dedicated",
      scratchDomainSuffix: "scratch.example.com",
      includeMcpContract: false,
      pollIntervalMs: 1,
    });

    for (const id of GOVERNED_PROBE_IDS) {
      expect(
        result.scenarios.find((scenario) => scenario.id === id),
        id,
      ).toMatchObject({ status: "pass" });
    }
    const authorized = target.requests
      .filter((request) => request.headers.has("authorization"))
      .map(
        (request) => `${request.init.method ?? "GET"} ${request.url.pathname}`,
      );
    expect(authorized).toEqual([
      "GET /v1/whoami",
      "POST /v1/projects/prj_dedicated/teardown",
      "GET /v1/tasks/tsk_teardown_1",
      "GET /v1/projects/prj_dedicated/resources",
      "POST /v1/quotes",
      "POST /v1/projects/prj_dedicated/launch",
      "GET /v1/tasks/tsk_launch",
      "GET /v1/projects/prj_dedicated/status",
      "POST /v1/projects/prj_dedicated/teardown",
      "GET /v1/tasks/tsk_teardown_2",
    ]);
  });

  it.each([
    ["quote", "receipt", "loop.quote"],
    ["launch", "undo", "loop.launch"],
    ["teardown", "budgetRemainingUsd", "loop.teardown"],
    ["launch", "nextActions", "loop.launch"],
    ["status", "nextActions", "loop.status_live"],
  ])(
    "fails %s when the governed response omits %s",
    async (stage, field, expectedProbe) => {
      const target = anonymousTarget({
        governed: true,
        omitGovernedField: { stage, field },
      });
      const result = await runPublicEvals({
        baseUrl: BASE_URL,
        fetchImpl: target.fetchImpl,
        agentKey: "agk_dedicated.secret",
        projectId: "prj_dedicated",
        scratchDomainSuffix: "scratch.example.com",
        includeMcpContract: false,
        pollIntervalMs: 1,
      });

      expect(
        result.scenarios.find((scenario) => scenario.id === expectedProbe),
      ).toMatchObject({
        status: "fail",
        error: expect.stringContaining(field),
      });
    },
  );

  it.each([
    ["quote", "loop.quote"],
    ["launch", "loop.launch"],
    ["teardown", "loop.teardown"],
  ])(
    "fails %s when the mutation response has no actionable next step",
    async (stage, expectedProbe) => {
      const target = anonymousTarget({
        governed: true,
        emptyNextActionsStage: stage,
      });
      const result = await runPublicEvals({
        baseUrl: BASE_URL,
        fetchImpl: target.fetchImpl,
        agentKey: "agk_dedicated.secret",
        projectId: "prj_dedicated",
        scratchDomainSuffix: "scratch.example.com",
        includeMcpContract: false,
        pollIntervalMs: 1,
      });

      expect(
        result.scenarios.find((scenario) => scenario.id === expectedProbe),
      ).toMatchObject({
        status: "fail",
        error: expect.stringContaining("nextActions"),
      });
    },
  );

  it("reconciles an accepted malformed reset without issuing another teardown", async () => {
    const target = anonymousTarget({
      governed: true,
      omitGovernedField: { stage: "reset", field: "receipt" },
    });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      agentKey: "agk_dedicated.secret",
      projectId: "prj_dedicated",
      scratchDomainSuffix: "scratch.example.com",
      includeMcpContract: false,
      pollIntervalMs: 1,
    });

    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.quote"),
    ).toMatchObject({
      status: "fail",
      error: expect.stringContaining("receipt"),
    });
    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.teardown"),
    ).toMatchObject({
      status: "pass",
      detail: {
        cleanup: "not_needed",
        reason: "no launch task was accepted and settled",
      },
    });
    expect(
      target.requests.some(
        (request) => request.url.pathname === "/v1/tasks/tsk_teardown_1",
      ),
    ).toBe(true);
    expect(
      target.requests.filter(
        (request) =>
          request.url.pathname === "/v1/projects/prj_dedicated/teardown" &&
          request.init.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("refuses cleanup when an accepted reset omits its task ID", async () => {
    const target = anonymousTarget({
      governed: true,
      missingTaskIdStage: "reset",
    });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      agentKey: "agk_dedicated.secret",
      projectId: "prj_dedicated",
      scratchDomainSuffix: "scratch.example.com",
      includeMcpContract: false,
      pollIntervalMs: 1,
    });

    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.quote"),
    ).toMatchObject({
      status: "fail",
      error: expect.stringContaining(
        "without a taskId; admission is ambiguous",
      ),
    });
    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.teardown"),
    ).toMatchObject({
      status: "fail",
      error: expect.stringContaining("pre-run reset admission is ambiguous"),
    });
    expect(
      target.requests.filter(
        (request) =>
          request.url.pathname === "/v1/projects/prj_dedicated/teardown" &&
          request.init.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      target.requests.some((request) =>
        request.url.pathname.startsWith("/v1/tasks/"),
      ),
    ).toBe(false);
  });

  it("reconciles an accepted malformed launch before final cleanup", async () => {
    const target = anonymousTarget({
      governed: true,
      omitGovernedField: { stage: "launch", field: "undo" },
    });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      agentKey: "agk_dedicated.secret",
      projectId: "prj_dedicated",
      scratchDomainSuffix: "scratch.example.com",
      includeMcpContract: false,
      pollIntervalMs: 1,
    });

    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.launch"),
    ).toMatchObject({
      status: "fail",
      error: expect.stringContaining("undo"),
    });
    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.teardown"),
    ).toMatchObject({ status: "pass" });

    const authorized = target.requests
      .filter((request) => request.headers.has("authorization"))
      .map(
        (request) => `${request.init.method ?? "GET"} ${request.url.pathname}`,
      );
    expect(
      authorized.indexOf("POST /v1/projects/prj_dedicated/launch"),
    ).toBeLessThan(authorized.indexOf("GET /v1/tasks/tsk_launch"));
    expect(authorized.indexOf("GET /v1/tasks/tsk_launch")).toBeLessThan(
      authorized.lastIndexOf("POST /v1/projects/prj_dedicated/teardown"),
    );
  });

  it("refuses cleanup when an accepted launch omits its task ID", async () => {
    const target = anonymousTarget({
      governed: true,
      missingTaskIdStage: "launch",
    });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      agentKey: "agk_dedicated.secret",
      projectId: "prj_dedicated",
      scratchDomainSuffix: "scratch.example.com",
      includeMcpContract: false,
      pollIntervalMs: 1,
    });

    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.launch"),
    ).toMatchObject({
      status: "fail",
      error: expect.stringContaining(
        "without a taskId; admission is ambiguous",
      ),
    });
    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.teardown"),
    ).toMatchObject({
      status: "fail",
      error: expect.stringContaining("launch admission is ambiguous"),
    });
    expect(
      target.requests.filter(
        (request) =>
          request.url.pathname === "/v1/projects/prj_dedicated/teardown" &&
          request.init.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("rejects direct governed evaluation over HTTP before sending the key", async () => {
    let requests = 0;
    await expect(
      runPublicEvals({
        baseUrl: "http://implementation.example",
        agentKey: "agk_dedicated.secret",
        projectId: "prj_dedicated",
        fetchImpl: async () => {
          requests += 1;
          return json({});
        },
      }),
    ).rejects.toThrow("governed profile requires an https base URL");
    expect(requests).toBe(0);
  });

  it("performs no mutation when the governed authority preflight is too broad", async () => {
    const target = anonymousTarget({
      governed: true,
      whoamiData: {
        authenticated: true,
        rung: 1,
        scopes: ["read", "provision", "teardown", "admin"],
        projects: [
          {
            id: "prj_dedicated",
            environment: "scratch",
            budgetCapUsd: 25,
          },
        ],
      },
    });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      agentKey: "agk_dedicated.secret",
      projectId: "prj_dedicated",
      scratchDomainSuffix: "scratch.example.com",
      includeMcpContract: false,
      pollIntervalMs: 1,
    });

    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.quote"),
    ).toMatchObject({
      status: "fail",
      error:
        "governed key must be rung 1 with exactly read, provision, and teardown scopes",
    });
    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.teardown"),
    ).toMatchObject({
      status: "fail",
      error:
        "governed authority preflight did not pass; refusing cleanup mutation",
    });
    const authorized = target.requests.filter((request) =>
      request.headers.has("authorization"),
    );
    expect(
      authorized.map(
        (request) => `${request.init.method ?? "GET"} ${request.url.pathname}`,
      ),
    ).toEqual(["GET /v1/whoami"]);
    expect(authorized.some((request) => request.init.method === "POST")).toBe(
      false,
    );
  });

  it("refuses fresh cleanup after an ambiguous launch failure", async () => {
    const target = anonymousTarget({ governed: true, launchFailure: true });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
      agentKey: "agk_dedicated.secret",
      projectId: "prj_dedicated",
      scratchDomainSuffix: "scratch.example.com",
      includeMcpContract: false,
      pollIntervalMs: 1,
    });

    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.launch"),
    ).toMatchObject({ status: "fail", error: "launch returned 503" });
    expect(
      result.scenarios.find((scenario) => scenario.id === "loop.teardown"),
    ).toMatchObject({
      status: "fail",
      error: expect.stringContaining("launch admission is ambiguous"),
    });
    expect(
      target.requests.filter(
        (request) =>
          request.url.pathname === "/v1/projects/prj_dedicated/teardown" &&
          request.init.method === "POST",
      ),
    ).toHaveLength(1);
  });
});
