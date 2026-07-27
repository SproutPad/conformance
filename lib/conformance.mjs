import {
  boundedRequest,
  canonicalBaseUrl,
  cleanError,
  parseJsonText,
} from "./http.mjs";
import { loadEnvelopeContract } from "./schema.mjs";

export const CHECKER_VERSION = "0.2.2";

export const WIRE_PROBE_IDS = [
  "error.unauthenticated_mutation",
  "error.input_invalid_domain",
  "error.bad_credential",
  "error.input_missing_query",
  "error.ap2_verify_invalid_input",
  "error.approvals_agent_credential",
  "success.domain_search",
];

function hasTypedActions(value) {
  const actions = Array.isArray(value?.actions)
    ? value.actions
    : Array.isArray(value?.data?.actions)
      ? value.data.actions
      : null;
  if (!actions || actions.length < 1) return false;
  return actions.every(
    (action) =>
      action &&
      typeof action === "object" &&
      typeof action.kind === "string" &&
      ["tool", "url", "stop", "manual"].includes(action.kind),
  );
}

export async function runEnvelopeConformance(options = {}) {
  const baseUrl = canonicalBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const contract = await loadEnvelopeContract();
  const probes = [];

  async function probe(id, kind, request, extraChecks = [], envelopeName) {
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
        envelopeName ??
        (kind === "error"
          ? "errorEnvelope"
          : kind === "success"
            ? "successEnvelope"
            : "envelope");
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

  const exactAgentError = ({
    status,
    blockedBy,
    allowHumanResolution = false,
  }) => {
    return (body, actualStatus) => {
      if (actualStatus !== status) {
        throw new Error(`expected HTTP ${status}, got ${actualStatus}`);
      }
      if (body.blockedBy !== blockedBy) {
        throw new Error(
          `expected blockedBy ${blockedBy}, got ${String(body.blockedBy)}`,
        );
      }
      if (typeof body.message !== "string" || body.message.length < 1) {
        throw new Error("agent error omitted message");
      }
      if (typeof body.retryable !== "boolean") {
        throw new Error("agent error omitted retryable");
      }
      if (!hasTypedActions(body)) {
        throw new Error("agent error omitted typed actions");
      }
      if (
        !allowHumanResolution &&
        Object.prototype.hasOwnProperty.call(body, "resolution")
      ) {
        throw new Error("agent error must not carry generic resolution");
      }
      if (
        Object.prototype.hasOwnProperty.call(body, "code") &&
        body.code !== body.blockedBy
      ) {
        throw new Error("agent error code must equal blockedBy when present");
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
      exactAgentError({
        status: 401,
        blockedBy: "auth:required",
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
      exactAgentError({
        status: 400,
        blockedBy: "input:invalid_domain",
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
      exactAgentError({
        // Forged/missing bearers both resolve to anonymous (no key-existence
        // oracle). Project ownership opacity (404 auth:not_your_project) is
        // reserved for authenticated principals that do not own the project.
        status: 401,
        blockedBy: "auth:required",
      }),
    ],
  );
  await probe(
    "error.input_missing_query",
    "error",
    { path: "/v1/domains/search" },
    [
      exactAgentError({
        status: 400,
        blockedBy: "input:missing_query",
      }),
    ],
  );
  await probe(
    "error.ap2_verify_invalid_input",
    "error",
    { method: "POST", path: "/v1/ap2/verify", body: { nope: true } },
    [
      exactAgentError({
        status: 400,
        blockedBy: "input:invalid",
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
      exactAgentError({
        status: 401,
        blockedBy: "auth:required",
        // Approvals is a human surface; resolution may remain for dashboard UX.
        allowHumanResolution: true,
      }),
    ],
    // Human-only envelope (MAY carry resolution). Agent errorEnvelope forbids it.
    "humanErrorEnvelope",
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
        if (!hasTypedActions(body)) {
          throw new Error("domain search omitted typed actions");
        }
        if (Object.prototype.hasOwnProperty.call(body, "nextActions")) {
          throw new Error(
            "domain search must not require prose nextActions on the agent dialect",
          );
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
