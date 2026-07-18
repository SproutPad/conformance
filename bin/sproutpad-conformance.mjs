#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CONFORMANCE_PROFILES, runConformanceSuite } from "../lib/suite.mjs";

function usage() {
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

export function parseArgs(argv) {
  const options = { json: false };
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
    `**${summary.summary.passed}/${summary.summary.total} required probes passed — ${summary.summary.outcome.toUpperCase()}**`,
    "",
  );
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
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
}
