import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import {
  canonicalJsonDigest,
  verifyCanonicalJson,
} from "./canonical.mjs";

export const CONFORMANCE_REPORT_SCHEMA_V1 =
  "sproutpad.conformance.run.v1";
export const CONFORMANCE_REPORT_SCHEMA_V2 =
  "sproutpad.conformance.run.v2";

export const CONFORMANCE_PROBE_INVENTORY_V1 = {
  wire: [
    "error.unauthenticated_mutation",
    "error.input_invalid_domain",
    "error.bad_credential",
    "error.input_missing_query",
    "error.ap2_verify_invalid_input",
    "error.approvals_agent_credential",
    "success.domain_search",
  ],
  discovery: [
    "discovery.llms_txt",
    "discovery.mcp_manifest",
    "discovery.openapi",
    "discovery.agents_md",
    "discovery.spec",
    "discovery.transparency",
    "anon.search_domains",
    "governance.structured_error_unauthenticated",
  ],
  governed: ["loop.quote", "loop.launch", "loop.status_live", "loop.teardown"],
};

export const CONFORMANCE_PROBE_INVENTORY_V2 = {
  wire: CONFORMANCE_PROBE_INVENTORY_V1.wire,
  discovery: [
    "discovery.llms_txt",
    "discovery.mcp_manifest",
    "discovery.mcp_tool_catalog",
    "mcp.initialize_anonymous",
    "mcp.tools_list_catalog_parity",
    "mcp.help_result_contract",
    "mcp.semantic_error_contract",
    "discovery.openapi",
    "discovery.agents_md",
    "discovery.spec",
    "discovery.transparency",
    "anon.search_domains",
    "governance.structured_error_unauthenticated",
  ],
  governed: CONFORMANCE_PROBE_INVENTORY_V1.governed,
};

export const CONFORMANCE_PROBE_INVENTORIES = {
  [CONFORMANCE_REPORT_SCHEMA_V1]: CONFORMANCE_PROBE_INVENTORY_V1,
  [CONFORMANCE_REPORT_SCHEMA_V2]: CONFORMANCE_PROBE_INVENTORY_V2,
};

export const PUBLIC_CONFORMANCE_TRUST = Object.freeze({
  baseUrl: "https://api.sproutpad.ai",
  jwksUrl: "https://api.sproutpad.ai/.well-known/conformance-jwks.json",
  repository: "SproutPad/sproutpad",
  workflowRef:
    "SproutPad/sproutpad/.github/workflows/public-conformance.yml@refs/heads/main",
  runnerProvenances: Object.freeze([
    Object.freeze({
      repository: "SproutPad/sproutpad",
      workflowRef:
        "SproutPad/sproutpad/.github/workflows/public-conformance.yml@refs/heads/main",
      status: "current",
    }),
    Object.freeze({
      repository: "robertexs/agentinfra",
      workflowRef:
        "robertexs/agentinfra/.github/workflows/public-conformance.yml@refs/heads/main",
      status: "historical",
    }),
  ]),
});

export const MAX_JWKS_BYTES = 1024 * 1024;
export const JWKS_FETCH_TIMEOUT_MS = 10_000;

export class ConformanceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {400 | 401 | 409 | 503} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ConformanceError";
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {string | undefined} requested
 * @returns {{ kind: "remote" | "file"; value: string }}
 */
export function resolveTrustedConformanceJwksSource(requested) {
  const value = requested || PUBLIC_CONFORMANCE_TRUST.jwksUrl;
  if (/^https?:\/\//i.test(value)) {
    if (value !== PUBLIC_CONFORMANCE_TRUST.jwksUrl) {
      throw new Error(
        `remote JWKS source must be exactly ${PUBLIC_CONFORMANCE_TRUST.jwksUrl}; use a local file for an explicit offline trust root`,
      );
    }
    return { kind: "remote", value };
  }
  return { kind: "file", value };
}

/**
 * @param {string | undefined} raw
 * @param {string} label
 * @returns {{ keys: Array<Record<string, unknown>> }}
 */
export function parsePublicJwks(raw, label) {
  if (!raw?.trim()) return { keys: [] };
  const parsed = JSON.parse(raw);
  const keys = Array.isArray(parsed) ? parsed : parsed.keys;
  if (!Array.isArray(keys)) throw new Error(`${label} must contain keys[]`);
  return {
    keys: keys.map((key) => {
      if (
        key.kty !== "EC" ||
        key.crv !== "P-256" ||
        !key.x ||
        !key.y ||
        !key.kid ||
        "d" in key
      ) {
        throw new Error(`${label} contains a non-public or non-P-256 key`);
      }
      return { ...key, alg: "ES256", use: "sig" };
    }),
  };
}

/**
 * Fetch JWKS from the pinned remote trust root or read a local file.
 * Never derives fetch destinations from bundle contents.
 *
 * @param {{ kind: "remote" | "file"; value: string }} source
 * @param {{ fetch?: typeof fetch; readFile?: typeof readFile }} [deps]
 */
export async function loadTrustedConformanceJwks(source, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const readFileImpl = deps.readFile ?? readFile;
  let jwksText;
  if (source.kind === "remote") {
    const response = await fetchImpl(PUBLIC_CONFORMANCE_TRUST.jwksUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`JWKS returned HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_JWKS_BYTES) {
      throw new Error("JWKS response is too large");
    }
    jwksText = await response.text();
    if (Buffer.byteLength(jwksText, "utf8") > MAX_JWKS_BYTES) {
      throw new Error("JWKS response is too large");
    }
  } else {
    jwksText = await readFileImpl(source.value, "utf8");
    if (Buffer.byteLength(jwksText, "utf8") > MAX_JWKS_BYTES) {
      throw new Error("JWKS file is too large");
    }
  }
  return parsePublicJwks(jwksText, "trusted conformance JWKS");
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConformanceError("conformance:schema", `${label} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} [max]
 */
function string(value, label, max = 500) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new ConformanceError("conformance:schema", `${label} is invalid`);
  }
  return value;
}

/**
 * @param {unknown} value
 */
export function parseReport(value) {
  const report = object(value, "report");
  const schemaVersion = report.schemaVersion;
  if (
    schemaVersion !== CONFORMANCE_REPORT_SCHEMA_V1 &&
    schemaVersion !== CONFORMANCE_REPORT_SCHEMA_V2
  ) {
    throw new ConformanceError(
      "conformance:schema_version",
      "Unsupported conformance report schemaVersion",
    );
  }
  const probeInventory = CONFORMANCE_PROBE_INVENTORIES[schemaVersion];
  if (report.profile !== "anonymous" && report.profile !== "governed") {
    throw new ConformanceError("conformance:schema", "profile is invalid");
  }
  const runId = string(report.runId, "runId", 160);
  if (!/^[A-Za-z0-9._:-]{3,160}$/.test(runId)) {
    throw new ConformanceError("conformance:schema", "runId is invalid");
  }
  const runner = object(report.runner, "runner");
  if (runner.kind !== "github-actions" && runner.kind !== "local") {
    throw new ConformanceError("conformance:schema", "runner.kind is invalid");
  }
  if (runner.workflow !== "public-conformance.yml") {
    throw new ConformanceError(
      "conformance:workflow",
      "Unexpected workflow claim",
    );
  }
  const target = object(report.target, "target");
  for (const digest of [target.specDigest, target.schemaDigest]) {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new ConformanceError(
        "conformance:schema",
        "Target digests must be SHA-256 hex",
      );
    }
  }
  const startedAt = string(report.startedAt, "startedAt", 40);
  const completedAt = string(report.completedAt, "completedAt", 40);
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    completed < started ||
    completed - started > 30 * 60_000
  ) {
    throw new ConformanceError(
      "conformance:time",
      "Report time range is invalid",
    );
  }
  if (!Array.isArray(report.suites)) {
    throw new ConformanceError("conformance:schema", "suites must be an array");
  }
  const suiteIds = new Set();
  const suites = report.suites.map((rawSuite) => {
    const suite = object(rawSuite, "suite");
    if (!(["wire", "discovery", "governed"]).includes(suite.id)) {
      throw new ConformanceError("conformance:schema", "Unknown suite id");
    }
    const suiteId = /** @type {"wire" | "discovery" | "governed"} */ (suite.id);
    if (suiteIds.has(suiteId)) {
      throw new ConformanceError("conformance:schema", "Duplicate suite id");
    }
    suiteIds.add(suiteId);
    if (typeof suite.required !== "boolean") {
      throw new ConformanceError(
        "conformance:schema",
        "suite.required is invalid",
      );
    }
    if (!(["pass", "fail", "not_run"]).includes(suite.outcome)) {
      throw new ConformanceError(
        "conformance:schema",
        "suite.outcome is invalid",
      );
    }
    if (!Array.isArray(suite.probes)) {
      throw new ConformanceError(
        "conformance:schema",
        "suite.probes is invalid",
      );
    }
    const probes = suite.probes.map((rawProbe) => {
      const probe = object(rawProbe, "probe");
      const id = string(probe.id, "probe.id", 160);
      if (!(["pass", "fail", "skip", "not_run"]).includes(probe.status)) {
        throw new ConformanceError(
          "conformance:schema",
          `Invalid status for ${id}`,
        );
      }
      return { ...probe, id, status: probe.status };
    });
    const expected = probeInventory[suiteId];
    const observed = probes.map((probe) => probe.id);
    if (
      observed.length !== expected.length ||
      expected.some((id, index) => observed[index] !== id)
    ) {
      throw new ConformanceError(
        "conformance:probe_inventory",
        `${suiteId} probe inventory does not match the published version`,
      );
    }
    const mustRun = suiteId !== "governed" || report.profile === "governed";
    if (Boolean(suite.required) !== mustRun) {
      throw new ConformanceError(
        "conformance:required_suite",
        `${suiteId} required flag does not match profile`,
      );
    }
    if (
      mustRun &&
      probes.some(
        (probe) => probe.status === "skip" || probe.status === "not_run",
      )
    ) {
      throw new ConformanceError(
        "conformance:required_probe_not_run",
        `Required ${suiteId} probe was skipped/not_run`,
      );
    }
    const expectedOutcome = mustRun
      ? probes.some((probe) => probe.status === "fail")
        ? "fail"
        : "pass"
      : "not_run";
    if (suite.outcome !== expectedOutcome) {
      throw new ConformanceError(
        "conformance:summary_mismatch",
        `${suiteId} outcome does not match probes`,
      );
    }
    return {
      id: suiteId,
      required: mustRun,
      outcome: expectedOutcome,
      probes,
    };
  });
  if (!suiteIds.has("wire") || !suiteIds.has("discovery") || !suiteIds.has("governed")) {
    throw new ConformanceError(
      "conformance:schema",
      "All suites must be present",
    );
  }
  const summary = object(report.summary, "summary");
  const requiredProbes = suites.flatMap((suite) =>
    suite.required ? suite.probes : [],
  );
  const passed = requiredProbes.filter(
    (probe) => probe.status === "pass",
  ).length;
  const failed = requiredProbes.filter(
    (probe) => probe.status === "fail",
  ).length;
  const skipped = requiredProbes.filter(
    (probe) => probe.status === "skip" || probe.status === "not_run",
  ).length;
  const outcome = failed === 0 && skipped === 0 ? "pass" : "fail";
  if (
    summary.passed !== passed ||
    summary.failed !== failed ||
    summary.skipped !== skipped ||
    summary.outcome !== outcome
  ) {
    throw new ConformanceError(
      "conformance:summary_mismatch",
      "Report summary does not match required probes",
    );
  }
  const previousDigest = report.previousDigest;
  if (
    previousDigest !== null &&
    (typeof previousDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(previousDigest))
  ) {
    throw new ConformanceError(
      "conformance:schema",
      "previousDigest is invalid",
    );
  }
  return {
    schemaVersion,
    profile: report.profile,
    runId,
    runner: {
      kind: runner.kind,
      repository: string(runner.repository, "runner.repository", 200),
      workflow: "public-conformance.yml",
      workflowRef: string(runner.workflowRef, "runner.workflowRef", 300),
      runUrl: string(runner.runUrl, "runner.runUrl", 500),
      commitSha: string(runner.commitSha, "runner.commitSha", 64),
      runAttempt: Number(runner.runAttempt),
    },
    target: {
      baseUrl: string(target.baseUrl, "target.baseUrl", 300),
      buildId: string(target.buildId, "target.buildId", 160),
      specDigest: target.specDigest,
      schemaDigest: target.schemaDigest,
    },
    startedAt,
    completedAt,
    suites,
    summary: { passed, failed, skipped, outcome },
    previousDigest,
  };
}

/**
 * @param {{
 *   report: unknown;
 *   digest: unknown;
 *   signature: unknown;
 * }} input
 * @param {{ keys: Array<Record<string, unknown>> }} jwks
 * @param {{
 *   expectedBaseUrl?: string;
 *   expectedRepository?: string;
 *   expectedWorkflowRef?: string;
 *   expectedRunnerProvenances?: ReadonlyArray<{ repository: string; workflowRef: string }>;
 *   expectedRunnerKind?: "github-actions" | "local";
 *   now?: Date;
 *   maxFutureSkewMs?: number;
 * }} [policy]
 */
export async function verifyConformanceBundle(input, jwks, policy = {}) {
  const errors = [];
  /** @type {ReturnType<typeof parseReport> | undefined} */
  let report;
  try {
    report = parseReport(input.report);
  } catch (error) {
    errors.push(
      error instanceof ConformanceError
        ? `${error.code}: ${error.message}`
        : "conformance:schema: Report is invalid",
    );
  }

  const digest =
    typeof input.digest === "string" && /^[a-f0-9]{64}$/.test(input.digest)
      ? input.digest
      : undefined;
  if (!digest) errors.push("conformance:digest: Digest is invalid");
  let digestMatches = false;
  if (report && digest) {
    try {
      digestMatches = canonicalJsonDigest(report) === digest;
    } catch {
      errors.push("conformance:digest: Canonical digest could not be computed");
    }
    if (!digestMatches) {
      errors.push("conformance:digest: Canonical digest mismatch");
    }
  }

  const signature =
    input.signature &&
    typeof input.signature === "object" &&
    !Array.isArray(input.signature)
      ? input.signature
      : undefined;
  const signatureShapeValid =
    signature?.alg === "ES256" &&
    typeof signature.kid === "string" &&
    typeof signature.jws === "string";
  if (!signatureShapeValid) {
    errors.push("conformance:signature: Signature is invalid");
  }
  let signatureValid = false;
  if (report && signatureShapeValid) {
    const matchingKeys = jwks.keys.filter((key) => key.kid === signature.kid);
    if (matchingKeys.length === 1) {
      try {
        signatureValid = await verifyCanonicalJson(
          report,
          signature,
          { keys: matchingKeys },
          { typ: "sproutpad-conformance-run+jws" },
        );
      } catch {
        signatureValid = false;
      }
    }
    if (!signatureValid) {
      errors.push("conformance:signature: Signature verification failed");
    }
  }

  let targetMatches = Boolean(report);
  let provenanceMatches = Boolean(report);
  let timeValid = Boolean(report);
  if (report) {
    if (
      policy.expectedBaseUrl &&
      report.target.baseUrl.replace(/\/$/, "") !==
        policy.expectedBaseUrl.replace(/\/$/, "")
    ) {
      targetMatches = false;
      errors.push("conformance:target: Unexpected target base URL");
    }
    const pairedProvenanceMatches =
      policy.expectedRunnerProvenances === undefined ||
      policy.expectedRunnerProvenances.some(
        (provenance) =>
          report.runner.repository === provenance.repository &&
          report.runner.workflowRef === provenance.workflowRef,
      );
    if (
      !pairedProvenanceMatches ||
      (policy.expectedRepository &&
        report.runner.repository !== policy.expectedRepository) ||
      (policy.expectedWorkflowRef &&
        report.runner.workflowRef !== policy.expectedWorkflowRef) ||
      (policy.expectedRunnerKind &&
        report.runner.kind !== policy.expectedRunnerKind)
    ) {
      provenanceMatches = false;
      errors.push("conformance:provenance: Unexpected runner provenance");
    }
    if (policy.now) {
      const completedAt = Date.parse(report.completedAt);
      const maxFutureSkewMs = policy.maxFutureSkewMs ?? 5 * 60_000;
      if (
        !Number.isFinite(completedAt) ||
        completedAt > policy.now.getTime() + maxFutureSkewMs
      ) {
        timeValid = false;
        errors.push("conformance:time: Report completion is in the future");
      }
    }
  }

  const schemaAndInventoryValid = Boolean(report);
  return {
    ok:
      schemaAndInventoryValid &&
      digestMatches &&
      signatureValid &&
      targetMatches &&
      provenanceMatches &&
      timeValid,
    ...(report
      ? {
          profile: report.profile,
          runId: report.runId,
          targetBaseUrl: report.target.baseUrl,
          targetBuildId: report.target.buildId,
          completedAt: report.completedAt,
          outcome: report.summary.outcome,
        }
      : {}),
    ...(digest ? { digest } : {}),
    checks: {
      schemaAndInventoryValid,
      digestMatches,
      signatureValid,
      targetMatches,
      provenanceMatches,
      timeValid,
    },
    errors: [...new Set(errors)],
  };
}
