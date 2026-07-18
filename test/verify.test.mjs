import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonDigest } from "../lib/canonical.mjs";
import {
  CONFORMANCE_PROBE_INVENTORIES,
  CONFORMANCE_REPORT_SCHEMA_V2,
  PUBLIC_CONFORMANCE_TRUST,
  resolveTrustedConformanceJwksSource,
  verifyConformanceBundle,
} from "../lib/verify.mjs";

function b64urlEncode(bytes) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlEncodeJson(value) {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function generateSigningMaterial(kid = "verify-test-1") {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
  return {
    privateKey,
    jwks: {
      keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }],
    },
    kid,
  };
}

async function signCanonicalReport(report, privateKey, kid) {
  const header = {
    alg: "ES256",
    kid,
    typ: "sproutpad-conformance-run+jws",
  };
  const headerPart = b64urlEncodeJson(header);
  const payloadPart = b64urlEncode(new TextEncoder().encode(canonicalJson(report)));
  const signingInput = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    signingInput,
  );
  return {
    alg: "ES256",
    kid,
    jws: `${headerPart}.${payloadPart}.${b64urlEncode(signature)}`,
  };
}

function sampleReport(profile = "anonymous") {
  const inventory = CONFORMANCE_PROBE_INVENTORIES[CONFORMANCE_REPORT_SCHEMA_V2];
  const suites = ["wire", "discovery", "governed"].map((id) => {
    const required = id !== "governed" || profile === "governed";
    return {
      id,
      required,
      outcome: required ? "pass" : "not_run",
      probes: inventory[id].map((probeId) => ({
        id: probeId,
        status: required ? "pass" : "not_run",
      })),
    };
  });
  const passed = suites.flatMap((suite) =>
    suite.required ? suite.probes : [],
  ).length;
  return {
    schemaVersion: CONFORMANCE_REPORT_SCHEMA_V2,
    profile,
    runId: `${profile}:verify-test:1`,
    runner: {
      kind: "github-actions",
      repository: PUBLIC_CONFORMANCE_TRUST.runnerProvenances[0].repository,
      workflow: "public-conformance.yml",
      workflowRef: PUBLIC_CONFORMANCE_TRUST.runnerProvenances[0].workflowRef,
      runUrl: "https://github.com/SproutPad/sproutpad/actions/runs/1",
      commitSha: "a".repeat(40),
      runAttempt: 1,
    },
    target: {
      baseUrl: PUBLIC_CONFORMANCE_TRUST.baseUrl,
      buildId: "build-verify-test",
      specDigest: "b".repeat(64),
      schemaDigest: "c".repeat(64),
    },
    startedAt: "2026-07-13T12:00:00.000Z",
    completedAt: "2026-07-13T12:00:05.000Z",
    suites,
    summary: { passed, failed: 0, skipped: 0, outcome: "pass" },
    previousDigest: null,
  };
}

async function signedBundle(profile = "anonymous") {
  const report = sampleReport(profile);
  const { privateKey, jwks, kid } = await generateSigningMaterial();
  const signature = await signCanonicalReport(report, privateKey, kid);
  return {
    bundle: {
      report,
      digest: canonicalJsonDigest(report),
      signature,
    },
    jwks,
  };
}

describe("verifyConformanceBundle", () => {
  it("accepts an ephemeral-key signed bundle with pinned trust policy", async () => {
    const { bundle, jwks } = await signedBundle();
    const verification = await verifyConformanceBundle(bundle, jwks, {
      expectedBaseUrl: PUBLIC_CONFORMANCE_TRUST.baseUrl,
      expectedRunnerProvenances: PUBLIC_CONFORMANCE_TRUST.runnerProvenances,
      expectedRunnerKind: "github-actions",
      now: new Date("2026-07-13T12:01:00.000Z"),
    });
    expect(verification.ok).toBe(true);
    expect(verification.checks).toMatchObject({
      schemaAndInventoryValid: true,
      digestMatches: true,
      signatureValid: true,
      targetMatches: true,
      provenanceMatches: true,
      timeValid: true,
    });
  });

  it("rejects digest and signature substitution", async () => {
    const { bundle, jwks } = await signedBundle();
    const badDigest = {
      ...bundle,
      digest: "0".repeat(64),
    };
    await expect(
      verifyConformanceBundle(badDigest, jwks, {
        expectedRunnerProvenances: PUBLIC_CONFORMANCE_TRUST.runnerProvenances,
        expectedRunnerKind: "github-actions",
        now: new Date("2026-07-13T12:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      checks: { digestMatches: false },
      errors: expect.arrayContaining([
        "conformance:digest: Canonical digest mismatch",
      ]),
    });

    const { privateKey, kid } = await generateSigningMaterial("other-key");
    const otherReport = sampleReport();
    otherReport.runId = "anonymous:other:1";
    const foreignSignature = await signCanonicalReport(
      otherReport,
      privateKey,
      kid,
    );
    const badSignature = {
      ...bundle,
      signature: foreignSignature,
    };
    await expect(
      verifyConformanceBundle(badSignature, jwks, {
        expectedRunnerProvenances: PUBLIC_CONFORMANCE_TRUST.runnerProvenances,
        expectedRunnerKind: "github-actions",
        now: new Date("2026-07-13T12:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      checks: { signatureValid: false },
    });
  });

  it("requires exact probe inventory order", async () => {
    const { bundle, jwks } = await signedBundle();
    const reordered = structuredClone(bundle);
    reordered.report.suites[0].probes.reverse();
    await expect(
      verifyConformanceBundle(reordered, jwks, {
        expectedRunnerProvenances: PUBLIC_CONFORMANCE_TRUST.runnerProvenances,
        expectedRunnerKind: "github-actions",
        now: new Date("2026-07-13T12:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      checks: { schemaAndInventoryValid: false },
      errors: expect.arrayContaining([
        expect.stringMatching(/conformance:probe_inventory/),
      ]),
    });
  });

  it("pins remote JWKS sources to the SproutPad trust root", () => {
    expect(resolveTrustedConformanceJwksSource(undefined)).toEqual({
      kind: "remote",
      value: PUBLIC_CONFORMANCE_TRUST.jwksUrl,
    });
    expect(() =>
      resolveTrustedConformanceJwksSource("https://attacker.example/jwks.json"),
    ).toThrow(/remote JWKS source must be exactly/);
    expect(resolveTrustedConformanceJwksSource("./local-jwks.json")).toEqual({
      kind: "file",
      value: "./local-jwks.json",
    });
  });
});

describe("live SproutPad bundle verification", () => {
  it("verifies the latest published anonymous bundle when available", async () => {
    let response;
    try {
      response = await fetch(
        `${PUBLIC_CONFORMANCE_TRUST.baseUrl}/v1/conformance/runs/latest`,
        { redirect: "error", signal: AbortSignal.timeout(10_000) },
      );
    } catch {
      return;
    }
    if (!response.ok) return;
    const body = await response.json();
    const run = body?.data?.anonymous?.run;
    if (!run?.report || !run?.digest || !run?.signature) return;

    let jwksResponse;
    try {
      jwksResponse = await fetch(PUBLIC_CONFORMANCE_TRUST.jwksUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return;
    }
    if (!jwksResponse.ok) return;
    const jwks = JSON.parse(await jwksResponse.text());

    const verification = await verifyConformanceBundle(
      {
        report: run.report,
        digest: run.digest,
        signature: run.signature,
      },
      jwks,
      {
        expectedBaseUrl: PUBLIC_CONFORMANCE_TRUST.baseUrl,
        expectedRunnerProvenances: PUBLIC_CONFORMANCE_TRUST.runnerProvenances,
        expectedRunnerKind: "github-actions",
        now: new Date(),
        maxFutureSkewMs: 10 * 60_000,
      },
    );
    expect(verification.ok).toBe(true);
  });
});
