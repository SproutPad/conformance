#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFORMANCE_PROFILES, runConformanceSuite } from "../lib/suite.mjs";
import {
  PUBLIC_CONFORMANCE_TRUST,
  loadTrustedConformanceJwks,
  resolveTrustedConformanceJwksSource,
  verifyConformanceBundle,
} from "../lib/verify.mjs";

/** True when this file is the process entry (including npm/npx .bin symlinks). */
export function isDirectCliInvocation(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return (
      realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

function looksLikeCliEntry(argv1 = process.argv[1]) {
  if (!argv1) return false;
  const base = basename(argv1);
  return (
    base === "sproutpad-conformance" || base === "sproutpad-conformance.mjs"
  );
}

function gradeUsage() {
  return `Usage: sproutpad-conformance [options]

Options:
  --base-url <url>   Deployment to grade (default: https://api.sproutpad.ai)
  --profile <name>   wire | anonymous | governed (default: anonymous)
  --json             Print the full machine-readable result
  --output <path>    Also write the full JSON result to a file
  --help             Show this help

The governed profile tears down and relaunches one dedicated disposable
project. Credentials are accepted only from CONFORMANCE_AGENT_KEY and
CONFORMANCE_PROJECT_ID; see the package README for the full guard.
`;
}

function verifyUsage() {
  return `Usage: sproutpad-conformance verify <bundle.json> [--jwks <file>]

Verify an offline signed conformance bundle (JCS digest + ES256 JWS).
When --jwks is omitted, the pinned SproutPad JWKS endpoint is fetched.
Local files are the supported offline trust root; remote sources must be
exactly ${PUBLIC_CONFORMANCE_TRUST.jwksUrl}.
`;
}

export function parseVerifyArgs(argv) {
  const bundlePath = argv[0];
  if (!bundlePath || bundlePath.startsWith("--")) {
    throw new Error("verify requires a bundle.json path");
  }
  let jwksPath;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true, bundlePath };
    if (arg === "--jwks") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--jwks requires a file path");
      }
      jwksPath = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown verify argument: ${arg}`);
  }
  return { bundlePath, jwksPath };
}

export function parseArgs(argv) {
  if (argv[0] === "verify") {
    return { mode: "verify", ...parseVerifyArgs(argv.slice(1)) };
  }
  const options = { mode: "grade", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (
      arg === "--base-url" ||
      arg === "--profile" ||
      arg === "--output"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--base-url") options.baseUrl = value;
      else if (arg === "--profile") {
        if (!CONFORMANCE_PROFILES.includes(value)) {
          throw new Error(
            `--profile must be one of: ${CONFORMANCE_PROFILES.join(", ")}`,
          );
        }
        options.profile = value;
      } else options.output = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, "<br>");
}

export function renderMarkdown(summary) {
  const passed = summary.summary.passed;
  const failed = summary.summary.failed;
  const skipped = summary.summary.skipped ?? 0;
  const total = summary.summary.total;
  const lines = [
    `## SproutPad conformance — ${summary.ranAt}`,
    "",
    `Target: ${summary.baseUrl}`,
    `Checker: ${summary.checkerVersion} · profile: ${summary.profile}`,
    `Schema: ${summary.schema.sha256}`,
    "Local result: unsigned and unpublished",
    "",
    "| Suite / probe | Required | Result |",
    "|---|---|---|",
  ];
  for (const suite of summary.suites) {
    for (const result of suite.probes) {
      const outcome =
        result.status === "pass"
          ? `PASS${result.httpStatus ? ` (${result.httpStatus})` : ""}`
          : result.status === "not_run"
            ? "not run"
            : `FAIL — ${result.error}`;
      lines.push(
        `| ${markdownCell(`${suite.id} / ${result.id}`)} | ${suite.required ? "yes" : "no"} | ${markdownCell(outcome)} |`,
      );
    }
  }
  lines.push(
    "",
    `**${passed}/${total} required probes passed — ${summary.summary.outcome.toUpperCase()}**`,
    "",
    `profile: ${summary.profile} · baseUrl: ${summary.baseUrl} · pass=${passed} fail=${failed} skip=${skipped}`,
  );
  if (summary.profile === "anonymous" || summary.profile === "wire") {
    lines.push(
      "governed: not_run (no credentials; verify published governed card via GET /v1/conformance/runs/latest)",
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function verifyBundle(bundlePath, jwksPath) {
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  if (!bundle.report || !bundle.digest || !bundle.signature) {
    throw new Error("bundle must contain report, digest, and signature");
  }
  const jwksSource = resolveTrustedConformanceJwksSource(jwksPath);
  const jwks = await loadTrustedConformanceJwks(jwksSource);
  const verification = await verifyConformanceBundle(bundle, jwks, {
    expectedBaseUrl: PUBLIC_CONFORMANCE_TRUST.baseUrl,
    expectedRunnerProvenances: PUBLIC_CONFORMANCE_TRUST.runnerProvenances,
    expectedRunnerKind: "github-actions",
    now: new Date(),
  });
  const report = bundle.report;
  const signature = bundle.signature;
  const matchedRunnerProvenance = PUBLIC_CONFORMANCE_TRUST.runnerProvenances.find(
    (provenance) =>
      report.runner?.repository === provenance.repository &&
      report.runner?.workflowRef === provenance.workflowRef,
  );
  return {
    valid: verification.ok,
    checks: verification.checks,
    errors: verification.errors,
    runId: typeof report.runId === "string" ? report.runId : verification.runId,
    digest:
      typeof bundle.digest === "string" ? bundle.digest : verification.digest,
    kid: typeof signature.kid === "string" ? signature.kid : undefined,
    trust: {
      target: PUBLIC_CONFORMANCE_TRUST.baseUrl,
      repository: PUBLIC_CONFORMANCE_TRUST.repository,
      workflowRef: PUBLIC_CONFORMANCE_TRUST.workflowRef,
      runnerProvenances: PUBLIC_CONFORMANCE_TRUST.runnerProvenances,
      matchedRunnerProvenance: matchedRunnerProvenance ?? null,
      jwksSource: jwksSource.value,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(
      options.mode === "verify" ? verifyUsage() : gradeUsage(),
    );
    return 0;
  }
  if (options.mode === "verify") {
    const result = await verifyBundle(options.bundlePath, options.jwksPath);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.valid ? 0 : 1;
  }
  const summary = await runConformanceSuite({
    baseUrl: options.baseUrl ?? process.env.BASE_URL,
    profile: options.profile ?? "anonymous",
    env: process.env,
  });
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (options.output) await writeFile(options.output, json, { flag: "w" });
  process.stdout.write(options.json ? json : renderMarkdown(summary));
  return summary.summary.outcome === "pass" ? 0 : 1;
}

if (isDirectCliInvocation()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    },
  );
} else if (looksLikeCliEntry()) {
  // Invoked under the CLI name but realpath resolution failed — never silent.
  process.stderr.write(
    "sproutpad-conformance: could not resolve CLI entry path (realpath mismatch)\n",
  );
  process.exitCode = 2;
}
