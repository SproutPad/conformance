import {
  boundedRequest,
  canonicalBaseUrl,
  cleanError,
  parseJsonText,
} from "./http.mjs";
import { loadEnvelopeContract } from "./schema.mjs";

export const CHECKER_VERSION = "0.1.0";

export const WIRE_PROBE_IDS = [
  "error.unauthenticated_mutation",
  "error.input_invalid_domain",
  "error.bad_credential",
  "error.input_missing_query",
  "error.ap2_verify_invalid_input",
  "error.approvals_agent_credential",
  "success.domain_search",
];

export async function runEnvelopeConformance(options = {}) {
  const baseUrl = canonicalBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const contract = await loadEnvelopeContract();
  const probes = [];

  async function probe(id, kind, request, extraChecks = []) {
    const started = Date.now();
    try {
      const { response, text } = await boundedRequest(
        fetchImpl,
        `${baseUrl}${request.path}`,
        {
          method: request.method ?? "GET",
          headers: {
            accept: "application/json",
            ...(request.body !== undefined
              ? { "content-type": "application/json" }
              : {}),
            ...(request.headers ?? {}),
          },
          ...(request.body !== undefined
            ? { body: JSON.stringify(request.body) }
            : {}),
        },
        {
          label: request.path,
          limitBytes: options.responseLimitBytes,
          timeoutMs: options.timeoutMs,
        },
      );
      const body = parseJsonText(text, request.path);
      if (body === undefined) {
        throw new Error(`empty JSON response (status ${response.status})`);
      }
      if (
        (kind === "error" &&
          (response.status < 400 || response.status >= 600)) ||
        (kind === "success" &&
          (response.status < 200 || response.status >= 300))
      ) {
        throw new Error(`${kind} envelope used HTTP status ${response.status}`);
      }
      const definition =
        kind === "error"
          ? "errorEnvelope"
          : kind === "success"
            ? "successEnvelope"
            : "envelope";
      contract.assert(definition, body, `${id} response`);
      for (const check of extraChecks) check(body, response.status);
      probes.push({
        id,
        status: "pass",
        latencyMs: Date.now() - started,
        httpStatus: response.status,
      });
    } catch (error) {
      probes.push({
        id,
        status: "fail",
        latencyMs: Date.now() - started,
        error: cleanError(error),
      });
    }
  }

  const exactError = ({ status, blockedBy, resolutionType }) => {
    return (body, actualStatus) => {
      if (actualStatus !== status) {
        throw new Error(`expected HTTP ${status}, got ${actualStatus}`);
      }
      if (body.blockedBy !== blockedBy) {
        throw new Error(
          `expected blockedBy ${blockedBy}, got ${String(body.blockedBy)}`,
        );
      }
      if (body.resolution?.type !== resolutionType) {
        throw new Error(
          `expected resolution.type ${resolutionType}, got ${String(body.resolution?.type)}`,
        );
      }
    };
  };

  await probe(
    "error.unauthenticated_mutation",
    "error",
    {
      method: "POST",
      path: "/v1/quotes",
      body: { projectId: "prj_none", domain: "example.com" },
    },
    [
      exactError({
        status: 401,
        blockedBy: "auth:required",
        resolutionType: "authenticate",
      }),
    ],
  );
  await probe(
    "error.input_invalid_domain",
    "error",
    {
      method: "POST",
      path: "/v1/estimate",
      body: { domain: "not a domain!" },
    },
    [
      exactError({
        status: 400,
        blockedBy: "input:invalid_domain",
        resolutionType: "retry",
      }),
    ],
  );
  await probe(
    "error.bad_credential",
    "error",
    {
      path: "/v1/projects/prj_none/status",
      headers: { authorization: "Bearer agk_bogus.bogus" },
    },
    [
      exactError({
        // A project-scoped read deliberately stays opaque: a forged bearer
        // against a project outside its ownership returns the same 404 as a
        // non-owned project, so it cannot reveal project existence.
        status: 404,
        blockedBy: "auth:not_your_project",
        resolutionType: "retry",
      }),
    ],
  );
  await probe(
    "error.input_missing_query",
    "error",
    { path: "/v1/domains/search" },
    [
      exactError({
        status: 400,
        blockedBy: "input:missing_query",
        resolutionType: "retry",
      }),
    ],
  );
  await probe(
    "error.ap2_verify_invalid_input",
    "error",
    { method: "POST", path: "/v1/ap2/verify", body: { nope: true } },
    [
      exactError({
        status: 400,
        blockedBy: "input:invalid",
        resolutionType: "retry",
      }),
    ],
  );
  await probe(
    "error.approvals_agent_credential",
    "error",
    {
      method: "POST",
      path: "/v1/approvals/tsk_none",
      body: { outcome: "approved" },
      headers: { authorization: "Bearer agk_bogus.bogus" },
    },
    [
      exactError({
        status: 401,
        blockedBy: "auth:required",
        resolutionType: "human_action",
      }),
    ],
  );
  await probe(
    "success.domain_search",
    "success",
    { path: "/v1/domains/search?query=conformance-probe" },
    [
      (body, status) => {
        if (status !== 200) throw new Error(`expected HTTP 200, got ${status}`);
        contract.assert(
          "actionableSuccessEnvelope",
          body,
          "success.domain_search response",
        );
        if (!Array.isArray(body.data?.results)) {
          throw new Error("domain search response missing data.results array");
        }
      },
    ],
  );

  return {
    checkerVersion: CHECKER_VERSION,
    baseUrl,
    schemaSource: contract.source,
    schemaSha256: contract.digest,
    ranAt: new Date().toISOString(),
    probes,
    conformant:
      probes.length === WIRE_PROBE_IDS.length &&
      probes.every((item) => item.status === "pass"),
  };
}
