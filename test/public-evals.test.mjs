import { describe, expect, it } from "vitest";
import {
  DISCOVERY_PROBE_IDS_V1,
  GOVERNED_PROBE_IDS,
  MCP_CONFORMANCE_PROTOCOL_VERSION,
  runPublicEvals,
} from "../lib/public-evals.mjs";
import { validMutationOpenApi } from "./fixtures/openapi.mjs";

const BASE_URL = "https://implementation.example";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function catalogTool(name) {
  return {
    operationId: name,
    title: `Title for ${name}`,
    description: `Description for ${name}`,
    authorization: { auth: "anonymous", scopes: [], humanOnly: false },
    behavior: {
      effect: "read",
      openWorld: false,
      destructive: false,
      idempotency: "none",
      taskMode: "none",
    },
    schemas: {
      input: { state: "complete", schemaId: `sproutpad.${name}.input.v2` },
      output: { state: "none" },
    },
    lifecycle: { status: "active" },
    bindings: {
      mcp: {
        toolName: name,
        annotations,
      },
    },
  };
}

function mcpCatalogTarget({
  manifestToolCatalogOnly = false,
  deprecatedCatalogTool = false,
} = {}) {
  const tools = [catalogTool("estimate"), catalogTool("help")];
  if (deprecatedCatalogTool) {
    tools[0] = { ...tools[0], lifecycle: { status: "deprecated" } };
  }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/llms.txt") return text("# SproutPad");
    if (url.pathname === "/.well-known/mcp.json") {
      return json(
        manifestToolCatalogOnly
          ? {
              url: `${BASE_URL}/mcp`,
              toolCatalog: `${BASE_URL}/.well-known/mcp-tools.json`,
              toolCount: tools.length,
            }
          : {
              url: `${BASE_URL}/mcp`,
              mcpDiscovery: `${BASE_URL}/.well-known/mcp-tools.json`,
              toolCount: tools.length,
            },
      );
    }
    if (url.pathname === "/.well-known/mcp-tools.json") {
      return json({
        name: "sproutpad",
        mcp: `${BASE_URL}/mcp`,
        docs: `${BASE_URL}/agents.md`,
        formatVersion: "2",
        contractDigest: "test-contract-digest",
        coverage: { complete: true, mcpOperationCount: tools.length },
        tools,
      });
    }
    if (url.pathname === "/mcp") {
      const rpc = JSON.parse(String(init.body));
      if (rpc.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (rpc.method === "initialize") {
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: MCP_CONFORMANCE_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "sproutpad", version: "build-test" },
          },
        });
      }
      if (rpc.method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            tools: tools.map((tool) => ({
              name: tool.bindings.mcp.toolName,
              title: tool.title,
              description: tool.description,
              annotations: tool.bindings.mcp.annotations,
              inputSchema: { type: "object" },
            })),
          },
        });
      }
      if (rpc.method === "tools/call") {
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            isError: false,
            structuredContent: {
              ok: true,
              kind: "index",
              topic: "quickstart",
              actions: [
                {
                  kind: "tool",
                  tool: "estimate",
                  arguments: {},
                  reason: "Continue",
                },
              ],
            },
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  kind: "index",
                  topic: "quickstart",
                  actions: [
                    {
                      kind: "tool",
                      tool: "estimate",
                      arguments: {},
                      reason: "Continue",
                    },
                  ],
                }),
              },
            ],
          },
        });
      }
      throw new Error(`unexpected MCP request ${rpc.method}`);
    }
    if (url.pathname === "/openapi.json") return json(validMutationOpenApi());
    if (url.pathname === "/agents.md") return text("# agents guide");
    if (url.pathname === "/spec.md") return text("# Governed Agent Spend");
    if (url.pathname === "/transparency") {
      return json({ data: { governance: {} } });
    }
    if (url.pathname === "/v1/domains/search") {
      return json({
        data: {
          results: [],
          truncated: false,
          actions: [
            {
              kind: "tool",
              tool: "estimate",
              arguments: {},
              requiredArguments: ["domain"],
              reason: "Price one concrete domain before quoting",
            },
          ],
        },
      });
    }
    if (url.pathname === "/v1/quotes") {
      return json(
        {
          blockedBy: "auth:required",
          message: "Authentication is required",
          retryable: false,
          actions: [
            {
              kind: "url",
              url: "https://api.sproutpad.ai/docs",
              purpose: "authenticate",
              requiresHuman: true,
            },
          ],
        },
        401,
      );
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  return { fetchImpl };
}

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
  emptyActionsStage,
  missingTaskIdStage,
  omitGovernedField,
  openApiDocument,
  flatOnlyTaskAdmission = false,
  flatOnlyQuoteVerdict = false,
} = {}) {
  const requests = [];
  let serviceLive = false;
  let teardownCount = 0;

  function mutatingEnvelope(stage, data, action, actions) {
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
        actions,
      },
    };
    if (omitGovernedField?.stage === stage) {
      if (omitGovernedField.field === "actions") {
        delete envelope.data.actions;
      } else {
        delete envelope.data[omitGovernedField.field];
      }
    }
    if (emptyActionsStage === stage) envelope.data.actions = [];
    return envelope;
  }

  function taskAdmissionEnvelope(stage, taskId, action, kind = "teardown") {
    const pollAction = {
      kind: "tool",
      tool: "get_task",
      arguments: { taskId },
      afterMs: 5_000,
      reason: "The durable operation is still running",
    };
    const envelope = {
      data: {
        task: {
          taskId,
          projectId: "prj_dedicated",
          kind,
          status: "working",
          terminal: false,
        },
        actions: [pollAction],
        result: {
          admission: {
            receipt: {
              action,
              oneTimeUsd: 0,
              monthlyDeltaUsd: 0,
              resources: [
                {
                  kind: "task",
                  provider: "sproutpad",
                  externalId: taskId,
                },
              ],
            },
            undo: { command: null, irreversible: true },
            budgetRemainingUsd: 25,
          },
          details: { dryRun: false },
        },
      },
    };
    if (omitGovernedField?.stage === stage) {
      if (omitGovernedField.field === "actions") {
        delete envelope.data.actions;
      } else if (
        omitGovernedField.field === "receipt" ||
        omitGovernedField.field === "undo"
      ) {
        delete envelope.data.result.admission[omitGovernedField.field];
      } else {
        delete envelope.data[omitGovernedField.field];
      }
    }
    if (emptyActionsStage === stage) envelope.data.actions = [];
    if (missingTaskIdStage === stage) {
      delete envelope.data.task.taskId;
      delete envelope.data.actions[0]?.arguments?.taskId;
    }
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
      return json({
        data: {
          results: [],
          truncated: false,
          actions: [
            {
              kind: "tool",
              tool: "estimate",
              arguments: {},
              requiredArguments: ["domain"],
              reason: "Price one concrete domain before quoting",
            },
          ],
        },
      });
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
        const quoteData = flatOnlyQuoteVerdict
          ? { verdict: "ALLOW" }
          : {
              quote: {
                projectId: "prj_dedicated",
                domain: "eval.scratch.example.com",
                target: "cloudflare",
                service: "evalweb",
                oneTimeUsd: 0,
                monthlyUsd: 0,
                domainOneTimeUsd: 0,
                computeMonthlyUsd: 0,
                budgetRemainingUsd: 25,
                verdict: "ALLOW",
                reservation: {
                  reservationId: "rsv_conformance",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                },
              },
            };
        return json(
          mutatingEnvelope(
            "quote",
            quoteData,
            "quote_budget_reserved",
            [
              {
                kind: "tool",
                tool: "launch_service",
                arguments: {
                  projectId: "prj_dedicated",
                  domain: "eval.scratch.example.com",
                  target: "cloudflare",
                  service: "evalweb",
                  reservationId: "rsv_conformance",
                },
                requiredArguments: ["bundleId", "justification"],
                reason:
                  "Stage a static asset bundle and supply the audited justification before launching.",
              },
            ],
          ),
        );
      }
      return json(
        {
          blockedBy: "auth:required",
          message: "Authentication is required",
          retryable: false,
          actions: [
            {
              kind: "url",
              url: "https://api.sproutpad.ai/docs",
              purpose: "authenticate",
              requiresHuman: true,
            },
          ],
        },
        401,
      );
    }
    if (
      governed &&
      url.pathname === "/v1/projects/prj_dedicated/teardown" &&
      init.method === "POST"
    ) {
      teardownCount += 1;
      serviceLive = false;
      const stage = teardownCount === 1 ? "reset" : "teardown";
      if (flatOnlyTaskAdmission && stage === "reset") {
        const taskId = `tsk_teardown_${teardownCount}`;
        return json(
          {
            data: {
              taskId,
              receipt: {
                action: "teardown_task_accepted",
                oneTimeUsd: 0,
                monthlyDeltaUsd: 0,
                resources: [
                  {
                    kind: "task",
                    provider: "sproutpad",
                    externalId: taskId,
                  },
                ],
              },
              undo: { command: null, irreversible: true },
              budgetRemainingUsd: 25,
              actions: [
                {
                  kind: "tool",
                  tool: "get_task",
                  arguments: { taskId },
                  reason: "Poll teardown to completion",
                },
              ],
            },
          },
          202,
        );
      }
      return json(
        taskAdmissionEnvelope(
          stage,
          `tsk_teardown_${teardownCount}`,
          "teardown_task_accepted",
          "teardown",
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
      url.pathname === "/v1/projects/prj_dedicated/assets" &&
      init.method === "POST"
    ) {
      return json(
        mutatingEnvelope(
          "assets",
          { bundleId: "bun_conformance" },
          "asset_bundle_staged",
          [
            {
              kind: "tool",
              tool: "launch_service",
              arguments: { bundleId: "bun_conformance" },
              reason: "Launch the staged static bundle",
            },
          ],
        ),
        201,
      );
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
        taskAdmissionEnvelope(
          "launch",
          "tsk_launch",
          "launch_service_task_accepted",
          "launch_site",
        ),
        202,
      );
    }
    if (governed && url.pathname === "/v1/projects/prj_dedicated/status") {
      const envelope = {
        data: {
          services: serviceLive ? [{ name: "evalweb", status: "live" }] : [],
          actions: [
            {
              kind: "tool",
              tool: "get_costs",
              arguments: { projectId: "prj_dedicated" },
              reason: "Inspect spend after launch",
            },
          ],
        },
      };
      if (
        omitGovernedField?.stage === "status" &&
        omitGovernedField.field === "actions"
      ) {
        delete envelope.data.actions;
      }
      return json(envelope);
    }
    if (governed && url.pathname.startsWith("/v1/tasks/tsk_")) {
      const taskId = url.pathname.slice("/v1/tasks/".length);
      return json({
        data: {
          task: {
            taskId,
            projectId: "prj_dedicated",
            kind: taskId.includes("launch") ? "launch_site" : "teardown",
            status: "completed",
            terminal: true,
          },
          actions: [
            {
              kind: "stop",
              reason: "Task completed",
            },
          ],
        },
      });
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

  it("fails discovery when OpenAPI retains prose nextActions on a mutation success", async () => {
    const openApiDocument = validMutationOpenApi();
    const firstPath = Object.keys(openApiDocument.paths)[0];
    const operation = openApiDocument.paths[firstPath].post;
    operation.responses["200"].content["application/json"].schema.properties =
      {
        data: { type: "object" },
        nextActions: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      };
    operation.responses["200"].content[
      "application/json"
    ].schema.required = ["data", "nextActions"];
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
      error: expect.stringContaining("nextActions"),
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
      "POST /v1/projects/prj_dedicated/assets",
      "POST /v1/quotes",
      "POST /v1/projects/prj_dedicated/launch",
      "GET /v1/tasks/tsk_launch",
      "GET /v1/projects/prj_dedicated/status",
      "POST /v1/projects/prj_dedicated/teardown",
      "GET /v1/tasks/tsk_teardown_2",
    ]);
    const staged = target.requests.find(
      (request) =>
        request.url.pathname === "/v1/projects/prj_dedicated/assets" &&
        request.init.method === "POST",
    );
    expect(JSON.parse(staged.init.body)).toEqual({
      files: [
        {
          path: "index.html",
          contentBase64:
            "PCFkb2N0eXBlIGh0bWw+PGh0bWw+PGhlYWQ+PHRpdGxlPlNwcm91dFBhZCBjb25mb3JtYW5jZTwvdGl0bGU+PC9oZWFkPjxib2R5PkNvbmZvcm1hbmNlIGNhbmFyeTwvYm9keT48L2h0bWw+",
        },
      ],
    });
    const launch = target.requests.find(
      (request) =>
        request.url.pathname === "/v1/projects/prj_dedicated/launch" &&
        request.init.method === "POST",
    );
    expect(JSON.parse(launch.init.body)).toMatchObject({
      target: "cloudflare",
      bundleId: "bun_conformance",
      service: "evalweb",
    });
    expect(JSON.parse(launch.init.body)).not.toHaveProperty("template");
  });

  it.each([
    ["quote", "receipt", "loop.quote"],
    ["launch", "undo", "loop.launch"],
    ["launch", "actions", "loop.launch"],
    ["status", "actions", "loop.status_live"],
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
        emptyActionsStage: stage,
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
        error: expect.stringContaining("actions"),
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
        "without nested data.task.taskId; admission is ambiguous",
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
        "without nested data.task.taskId; admission is ambiguous",
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

  it("fails flat-only teardown admission that omits nested data.task", async () => {
    const target = anonymousTarget({
      governed: true,
      flatOnlyTaskAdmission: true,
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
      error: expect.stringContaining("without nested data.task.taskId"),
    });
  });

  it("fails flat-only quote decision that omits nested data.quote", async () => {
    const target = anonymousTarget({
      governed: true,
      flatOnlyQuoteVerdict: true,
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
      error: expect.stringContaining("without nested data.quote"),
    });
  });

  it("fails an otherwise-valid v2 catalog linked only through toolCatalog", async () => {
    const target = mcpCatalogTarget({ manifestToolCatalogOnly: true });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
    });
    expect(
      result.scenarios.find(
        (scenario) => scenario.id === "discovery.mcp_tool_catalog",
      ),
    ).toMatchObject({
      status: "fail",
      error:
        "MCP manifest did not link the canonical tool catalog via mcpDiscovery",
    });
  });

  it("fails a v2 catalog tool that still uses deprecated lifecycle", async () => {
    const target = mcpCatalogTarget({ deprecatedCatalogTool: true });
    const result = await runPublicEvals({
      baseUrl: BASE_URL,
      fetchImpl: target.fetchImpl,
    });
    expect(
      result.scenarios.find(
        (scenario) => scenario.id === "discovery.mcp_tool_catalog",
      ),
    ).toMatchObject({
      status: "fail",
      error: "estimate: catalog lifecycle was invalid",
    });
  });
});
