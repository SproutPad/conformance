import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseArgs, renderMarkdown } from "../bin/sproutpad-conformance.mjs";
import {
  CHECKER_VERSION,
  WIRE_PROBE_IDS,
  runEnvelopeConformance,
} from "../lib/conformance.mjs";
import { cleanError } from "../lib/http.mjs";
import { governedOptionsFromEnv, runConformanceSuite } from "../lib/suite.mjs";

function response(body, status = 400) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function conformingFetch(requests) {
  return async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (
      url.pathname === "/v1/domains/search" &&
      url.searchParams.has("query")
    ) {
      return response(
        { data: { results: [] }, nextActions: ["estimate"] },
        200,
      );
    }
    if (url.pathname === "/v1/domains/search") {
      return response({
        blockedBy: "input:missing_query",
        message: "query is required",
        resolution: { type: "retry", hint: "pass ?query=<domain>" },
      });
    }
    if (url.pathname === "/v1/estimate") {
      return response({
        blockedBy: "input:invalid_domain",
        message: "invalid domain",
        resolution: { type: "retry", hint: "fix the domain" },
      });
    }
    if (url.pathname === "/v1/ap2/verify") {
      return response({
        blockedBy: "input:invalid",
        message: "mandate tokens are required",
        resolution: { type: "retry", hint: "supply every token" },
      });
    }
    if (url.pathname === "/v1/projects/prj_none/status") {
      return response(
        {
          blockedBy: "auth:not_your_project",
          message: "Project not found",
          resolution: { type: "retry", hint: "check the project id" },
        },
        404,
      );
    }
    if (url.pathname.startsWith("/v1/approvals/")) {
      return response(
        {
          blockedBy: "auth:required",
          message: "A signed-in human must decide",
          resolution: { type: "human_action", path: "/app" },
        },
        401,
      );
    }
    return response(
      {
        blockedBy: "auth:required",
        message: "Authentication is required",
        resolution: { type: "authenticate", path: "/docs" },
      },
      401,
    );
  };
}

describe("standalone conformance package", () => {
  it("grades responses with the bundled schema instead of trusting the target", async () => {
    const requests = [];
    const result = await runEnvelopeConformance({
      baseUrl: "https://implementation.example",
      fetchImpl: conformingFetch(requests),
    });

    expect(result.conformant).toBe(true);
    expect(result.probes.map((probe) => probe.id)).toEqual(WIRE_PROBE_IDS);
    expect(result.schemaSource).toBe(
      "@sproutpad/conformance/spec/envelope.schema.json",
    );
    expect(result.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(requests.some((url) => url.pathname.includes("/spec/"))).toBe(false);
  });

  it("accepts the opaque non-owned-project response for a forged bearer", async () => {
    const result = await runEnvelopeConformance({
      baseUrl: "https://implementation.example",
      fetchImpl: conformingFetch([]),
    });

    expect(result.conformant).toBe(true);
    expect(
      result.probes.find((probe) => probe.id === "error.bad_credential"),
    ).toMatchObject({
      status: "pass",
      httpStatus: 404,
    });
  });

  it("marks standalone suite output as local, unsigned evidence", async () => {
    const result = await runConformanceSuite({
      profile: "wire",
      baseUrl: "https://implementation.example",
      fetchImpl: conformingFetch([]),
    });
    expect(result).toMatchObject({
      schemaVersion: "sproutpad.conformance.local.v1",
      profile: "wire",
      conformant: true,
      localResult: { signed: false, published: false },
      summary: { outcome: "pass" },
    });
    expect(result.schema.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails the grade when a resolvable error omits its next step", async () => {
    const result = await runEnvelopeConformance({
      baseUrl: "https://implementation.example",
      fetchImpl: async () =>
        response({ blockedBy: "auth:required", message: "No resolution" }),
    });
    expect(result.conformant).toBe(false);
    expect(result.probes.every((probe) => probe.status === "fail")).toBe(true);
  });

  it("rejects a valid error envelope returned with a success status", async () => {
    const result = await runEnvelopeConformance({
      baseUrl: "https://implementation.example",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (
          url.pathname === "/v1/domains/search" &&
          url.searchParams.has("query")
        ) {
          return response(
            { data: { results: [] }, nextActions: ["estimate"] },
            200,
          );
        }
        return response(
          {
            blockedBy: "auth:required",
            message: "Authentication is required",
            resolution: { type: "authenticate", path: "/docs" },
          },
          200,
        );
      },
    });

    expect(result.conformant).toBe(false);
    expect(
      result.probes
        .filter((probe) => probe.id.startsWith("error."))
        .every((probe) => probe.status === "fail"),
    ).toBe(true);
    expect(result.probes.at(-1)?.status).toBe("pass");
  });

  it("does not let one generic auth error satisfy the named wire probes", async () => {
    const result = await runEnvelopeConformance({
      baseUrl: "https://implementation.example",
      fetchImpl: async () =>
        response(
          {
            blockedBy: "auth:required",
            message: "Authentication is required",
            resolution: { type: "authenticate", path: "/docs" },
          },
          401,
        ),
    });

    expect(result.conformant).toBe(false);
    for (const id of [
      "error.input_invalid_domain",
      "error.input_missing_query",
      "error.ap2_verify_invalid_input",
      "error.approvals_agent_credential",
      "success.domain_search",
    ]) {
      expect(
        result.probes.find((probe) => probe.id === id),
        id,
      ).toMatchObject({
        status: "fail",
      });
    }
  });

  it("keeps version and compound license aligned with package metadata", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(CHECKER_VERSION).toBe(packageJson.version);
    expect(packageJson.license).toBe("MIT AND CC-BY-4.0");
  });

  it("parses an explicit target and machine-readable output options", () => {
    expect(
      parseArgs([
        "--base-url",
        "https://implementation.example",
        "--profile",
        "anonymous",
        "--json",
        "--output",
        "report.json",
      ]),
    ).toEqual({
      baseUrl: "https://implementation.example",
      profile: "anonymous",
      json: true,
      output: "report.json",
    });
  });

  it("rejects credential-bearing and non-HTTP targets", async () => {
    await expect(
      runEnvelopeConformance({
        baseUrl: "https://agent:secret@implementation.example",
        fetchImpl: conformingFetch([]),
      }),
    ).rejects.toThrow("must not contain credentials");

    await expect(
      runEnvelopeConformance({
        baseUrl: "file:///tmp/implementation",
        fetchImpl: conformingFetch([]),
      }),
    ).rejects.toThrow("must use http or https");
  });

  it("escapes target-controlled text in the Markdown table", () => {
    const rendered = renderMarkdown({
      ranAt: "2026-07-16T00:00:00.000Z",
      baseUrl: "https://implementation.example",
      checkerVersion: "0.1.0",
      profile: "wire",
      schema: { sha256: "a".repeat(64) },
      suites: [
        {
          id: "wire",
          required: true,
          probes: [
            {
              id: "probe",
              status: "fail",
              error: "first | second\nforged row",
            },
          ],
        },
      ],
      summary: { passed: 0, total: 1, outcome: "fail" },
    });

    expect(rendered).toContain("first \\| second<br>forged row");
    expect(rendered).not.toContain("second\nforged row");
  });

  it("bounds untrusted response bodies before parsing them", async () => {
    const result = await runEnvelopeConformance({
      baseUrl: "https://implementation.example",
      fetchImpl: async () =>
        new Response("{}", {
          status: 400,
          headers: { "content-length": "1000001" },
        }),
    });

    expect(result.conformant).toBe(false);
    expect(result.probes[0]?.error).toContain("byte safety limit");
  });

  it("redacts common credential forms from target-controlled errors", () => {
    const awsAccessKey = ["AKIA", "1234567890ABCDEF"].join("");
    const githubToken = ["ghp_", "12345678901234567890"].join("");
    const cleaned = cleanError(
      new Error(
        `{"apiKey":"${awsAccessKey}"} ${githubToken} -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----`,
      ),
    );
    expect(cleaned).not.toContain(awsAccessKey);
    expect(cleaned).not.toContain(githubToken);
    expect(cleaned).not.toContain("BEGIN PRIVATE KEY");
    expect(cleaned).toContain("[redacted]");
  });

  it("requires an exact destructive confirmation before any governed request", async () => {
    let requests = 0;
    await expect(
      runConformanceSuite({
        profile: "governed",
        baseUrl: "https://implementation.example",
        env: {
          CONFORMANCE_AGENT_KEY: "agk_dedicated.secret",
          CONFORMANCE_PROJECT_ID: "prj_dedicated",
          CONFORMANCE_SCRATCH_SUFFIX: "scratch.example.com",
          CONFORMANCE_GOVERNED_CONFIRM: "no",
        },
        fetchImpl: async () => {
          requests += 1;
          return response({}, 200);
        },
      }),
    ).rejects.toThrow("governed profile is destructive");
    expect(requests).toBe(0);
  });

  it("loads governed credentials only from the supplied environment", () => {
    expect(
      governedOptionsFromEnv(
        {
          CONFORMANCE_AGENT_KEY: "agk_dedicated.secret",
          CONFORMANCE_PROJECT_ID: "prj_dedicated",
          CONFORMANCE_SCRATCH_SUFFIX: "scratch.example.com",
          CONFORMANCE_GOVERNED_CONFIRM:
            "TEARDOWN:https://implementation.example:prj_dedicated",
        },
        "https://implementation.example",
      ),
    ).toMatchObject({
      agentKey: "agk_dedicated.secret",
      projectId: "prj_dedicated",
      scratchDomainSuffix: "scratch.example.com",
      expectedBudgetCapUsd: 25,
    });
  });

  it("bounds an explicit governed budget expectation", () => {
    const base = {
      CONFORMANCE_AGENT_KEY: "agk_dedicated.secret",
      CONFORMANCE_PROJECT_ID: "prj_dedicated",
      CONFORMANCE_SCRATCH_SUFFIX: "scratch.example.com",
      CONFORMANCE_GOVERNED_CONFIRM:
        "TEARDOWN:https://implementation.example:prj_dedicated",
    };
    expect(
      governedOptionsFromEnv(
        {
          ...base,
          CONFORMANCE_EXPECTED_BUDGET_USD: "5",
        },
        "https://implementation.example",
      ).expectedBudgetCapUsd,
    ).toBe(5);
    expect(() =>
      governedOptionsFromEnv(
        {
          ...base,
          CONFORMANCE_EXPECTED_BUDGET_USD: "26",
        },
        "https://implementation.example",
      ),
    ).toThrow("must be between 1 and 25");
  });

  it("binds destructive confirmation to the canonical target origin", () => {
    const env = {
      CONFORMANCE_AGENT_KEY: "agk_dedicated.secret",
      CONFORMANCE_PROJECT_ID: "prj_dedicated",
      CONFORMANCE_SCRATCH_SUFFIX: "scratch.example.com",
      CONFORMANCE_GOVERNED_CONFIRM:
        "TEARDOWN:https://implementation.example:prj_dedicated",
    };

    expect(() =>
      governedOptionsFromEnv(
        env,
        "https://IMPLEMENTATION.example:443/some/prefix/",
      ),
    ).not.toThrow();
    expect(() => governedOptionsFromEnv(env, "https://other.example")).toThrow(
      "CONFORMANCE_GOVERNED_CONFIRM=TEARDOWN:https://other.example:prj_dedicated",
    );
  });

  it("rejects plaintext governed targets before making any request", async () => {
    let requests = 0;
    await expect(
      runConformanceSuite({
        profile: "governed",
        baseUrl: "http://implementation.example",
        env: {
          CONFORMANCE_AGENT_KEY: "agk_dedicated.secret",
          CONFORMANCE_PROJECT_ID: "prj_dedicated",
          CONFORMANCE_SCRATCH_SUFFIX: "scratch.example.com",
          CONFORMANCE_GOVERNED_CONFIRM:
            "TEARDOWN:http://implementation.example:prj_dedicated",
        },
        fetchImpl: async () => {
          requests += 1;
          return response({}, 200);
        },
      }),
    ).rejects.toThrow("governed profile requires an https base URL");
    expect(requests).toBe(0);
  });
});
