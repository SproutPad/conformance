import { CHECKER_VERSION, runEnvelopeConformance } from "./conformance.mjs";
import { canonicalBaseUrl, requireGovernedHttps } from "./http.mjs";
import {
  DISCOVERY_PROBE_IDS,
  GOVERNED_PROBE_IDS,
  runPublicEvals,
} from "./public-evals.mjs";

export const CONFORMANCE_PROFILES = ["wire", "anonymous", "governed"];

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function governedOptionsFromEnv(
  env = process.env,
  baseUrl = "https://api.sproutpad.ai",
) {
  const governedBaseUrl = requireGovernedHttps(baseUrl);
  const agentKey = env.CONFORMANCE_AGENT_KEY?.trim();
  const projectId = env.CONFORMANCE_PROJECT_ID?.trim();
  const scratchDomainSuffix = env.CONFORMANCE_SCRATCH_SUFFIX?.trim();
  if (!agentKey || !projectId) {
    throw new Error(
      "governed profile requires CONFORMANCE_AGENT_KEY and CONFORMANCE_PROJECT_ID",
    );
  }
  if (!scratchDomainSuffix) {
    throw new Error(
      "governed profile requires CONFORMANCE_SCRATCH_SUFFIX for the disposable launch domain",
    );
  }
  const targetOrigin = new URL(governedBaseUrl).origin;
  const expectedConfirmation = `TEARDOWN:${targetOrigin}:${projectId}`;
  if (env.CONFORMANCE_GOVERNED_CONFIRM !== expectedConfirmation) {
    throw new Error(
      `governed profile is destructive; set CONFORMANCE_GOVERNED_CONFIRM=${expectedConfirmation} only for a dedicated disposable project`,
    );
  }
  return {
    agentKey,
    projectId,
    scratchDomainSuffix,
    expectedBudgetCapUsd: boundedInteger(
      env.CONFORMANCE_EXPECTED_BUDGET_USD,
      25,
      1,
      25,
      "CONFORMANCE_EXPECTED_BUDGET_USD",
    ),
    launchTimeoutMs: boundedInteger(
      env.CONFORMANCE_LAUNCH_TIMEOUT_MS,
      240_000,
      30_000,
      900_000,
      "CONFORMANCE_LAUNCH_TIMEOUT_MS",
    ),
    pollIntervalMs: boundedInteger(
      env.CONFORMANCE_POLL_INTERVAL_MS,
      3_000,
      250,
      30_000,
      "CONFORMANCE_POLL_INTERVAL_MS",
    ),
  };
}

function requiredProbe(id) {
  return {
    id,
    status: "fail",
    error: "checker omitted required probe",
  };
}

function selectProbes(probes, ids) {
  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  return ids.map((id) => byId.get(id) ?? requiredProbe(id));
}

function buildSuite(id, required, probes) {
  const hasFailure = probes.some((probe) => probe.status === "fail");
  const hasNotRun = probes.some((probe) => probe.status === "not_run");
  return {
    id,
    required,
    outcome: required ? (hasFailure || hasNotRun ? "fail" : "pass") : "not_run",
    probes,
  };
}

export async function runConformanceSuite(options = {}) {
  const profile = options.profile ?? "anonymous";
  if (!CONFORMANCE_PROFILES.includes(profile)) {
    throw new Error(
      `profile must be one of: ${CONFORMANCE_PROFILES.join(", ")}`,
    );
  }
  const baseUrl =
    profile === "governed"
      ? requireGovernedHttps(options.baseUrl)
      : canonicalBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const governed =
    profile === "governed"
      ? governedOptionsFromEnv(options.env ?? process.env, baseUrl)
      : undefined;

  const wire = await runEnvelopeConformance({
    baseUrl,
    fetchImpl,
    ...(options.requestTimeoutMs
      ? { timeoutMs: options.requestTimeoutMs }
      : {}),
  });
  const suites = [buildSuite("wire", true, wire.probes)];

  if (profile !== "wire") {
    const publicEvals = await runPublicEvals({
      baseUrl,
      fetchImpl,
      includeMcpContract: true,
      ...(profile === "governed" && wire.conformant ? governed : {}),
      ...(options.requestTimeoutMs
        ? {
            requestTimeoutMs: options.requestTimeoutMs,
            mcpTimeoutMs: options.requestTimeoutMs,
          }
        : {}),
    });
    suites.push(
      buildSuite(
        "discovery",
        true,
        selectProbes(publicEvals.scenarios, DISCOVERY_PROBE_IDS),
      ),
      buildSuite(
        "governed",
        profile === "governed",
        selectProbes(publicEvals.scenarios, GOVERNED_PROBE_IDS),
      ),
    );
  }

  const requiredProbes = suites.flatMap((suite) =>
    suite.required ? suite.probes : [],
  );
  const passed = requiredProbes.filter(
    (probe) => probe.status === "pass",
  ).length;
  const failed = requiredProbes.length - passed;
  const outcome = failed === 0 ? "pass" : "fail";
  return {
    schemaVersion: "sproutpad.conformance.local.v1",
    checkerVersion: CHECKER_VERSION,
    profile,
    baseUrl,
    ranAt: new Date().toISOString(),
    schema: {
      source: wire.schemaSource,
      sha256: wire.schemaSha256,
    },
    suites,
    summary: {
      passed,
      failed,
      total: requiredProbes.length,
      outcome,
    },
    localResult: {
      signed: false,
      published: false,
      note: "This standalone result is local evidence, not a SproutPad-operated signed or published conformance run.",
    },
    conformant: outcome === "pass",
  };
}
