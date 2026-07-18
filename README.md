# SproutPad conformance checker

> **Release status:** public and runnable. Pin
> [`@sproutpad/conformance@0.1.1`](https://www.npmjs.com/package/@sproutpad/conformance)
> (source: [`SproutPad/conformance`](https://github.com/SproutPad/conformance)).
> Prefer the npm pin for reproducible digests; `npx --yes github:SproutPad/conformance`
> remains a secondary path.

An independently runnable checker for SproutPad's public wire contract,
discovery surfaces, MCP contract, and optional governed scratch loop. The
default profile is credential-free. It grades responses against the schema
bundled with this package; a target cannot make itself pass by serving a weaker
schema.

**Exit codes:** `0` = grade/verify pass; `1` = grade/verify fail; `2` = usage
error or CLI entrypoint failure (never silent success).

## Run it

```bash
npx @sproutpad/conformance@0.1.1 --base-url https://api.sproutpad.ai
# Secondary (tracks GitHub main tip):
# npx --yes github:SproutPad/conformance --base-url https://api.sproutpad.ai
```

That runs the `anonymous` profile: wire-envelope probes plus public discovery,
MCP initialization/tool parity, structured errors, and anonymous search.
Default human output prints profile, baseUrl, pass/fail/skip counts, and notes
that governed stays `not_run` without credentials — that stub is expected, not
a defect. Public anonymous green means wire + discovery (+ MCP) only. SproutPad's
separately signed `profile: "governed"` card at
`GET /v1/conformance/runs/latest` (`.data.governed`) is the operator money-loop
attestation; outsiders verify that card offline rather than re-running the canary.

For the smaller envelope-only grade:

```bash
npx @sproutpad/conformance@0.1.1 \
  --profile wire \
  --base-url https://api.sproutpad.ai
```

Machine-readable output:

```bash
npx @sproutpad/conformance@0.1.1 \
  --base-url https://api.sproutpad.ai \
  --json \
  --output conformance.json
```

The command exits `0` only when every required probe passes. `wire` and
`anonymous` use no account or API key. Their probes exercise anonymous reads
and deliberately rejected requests; they do not purchase, provision, approve,
or tear down resources.

## Verify a published signed run (outsider)

SproutPad publishes signed anonymous and governed cards at
`GET /v1/conformance/runs/latest`. Outsiders do **not** need access to the
private Actions `runner.runUrl` (it may 404). Cryptographic verification uses
the public API bundle + JWKS:

```bash
curl -sS https://api.sproutpad.ai/v1/conformance/runs/latest \
  | jq '.data.anonymous.run | {report,digest,signature}' > bundle.json

npx @sproutpad/conformance@0.1.1 verify bundle.json

# Governed card (separate signed profile; outsiders verify, they do not re-run):
curl -sS https://api.sproutpad.ai/v1/conformance/runs/latest \
  | jq '.data.governed.run | {report,digest,signature}' > governed-bundle.json
npx @sproutpad/conformance@0.1.1 verify governed-bundle.json
```

By default the verifier fetches the pinned SproutPad JWKS at
`https://api.sproutpad.ai/.well-known/conformance-jwks.json` (no redirects,
10s timeout, 1 MiB cap). It never trusts a JWKS URL found inside the bundle.
For air-gapped verification, pass a local JWKS file:

```bash
curl -sS https://api.sproutpad.ai/.well-known/conformance-jwks.json > jwks.json
npx @sproutpad/conformance@0.1.1 verify bundle.json --jwks jwks.json
```

The check recomputes the JCS digest (ECMAScript number serialization, UTF-16
key order) and verifies the ES256 JWS with purpose
`sproutpad-conformance-run+jws`, then pins target URL and runner provenance to
SproutPad's published trust policy. Exit code `0` means every check passed.

Programmatic use:

```javascript
import { verifyConformanceBundle, loadTrustedConformanceJwks, resolveTrustedConformanceJwksSource } from "@sproutpad/conformance/verify";
import { canonicalJsonDigest } from "@sproutpad/conformance/canonical";
```

## Governed scratch profile

`governed` is deliberately harder to invoke because it mutates one project.
SproutPad does **not** publish the canary agent key. Outsiders should verify
the published governed card (above) or use the fake-money `/sandbox` for
mutation demos. Operators with a dedicated disposable project may re-run:

```bash
export CONFORMANCE_AGENT_KEY='agk_...'
export CONFORMANCE_PROJECT_ID='prj_dedicated_disposable_eval'
export CONFORMANCE_SCRATCH_SUFFIX='scratch.example.com'
export CONFORMANCE_TARGET_ORIGIN='https://api.example.com'
export CONFORMANCE_GOVERNED_CONFIRM="TEARDOWN:${CONFORMANCE_TARGET_ORIGIN}:${CONFORMANCE_PROJECT_ID}"
# Optional only when the disposable project's cap is below the $25 default:
# export CONFORMANCE_EXPECTED_BUDGET_USD='5'

npx @sproutpad/conformance@0.1.1 \
  --profile governed \
  --base-url "${CONFORMANCE_TARGET_ORIGIN}"
```

Before the first mutation, the checker calls `GET /v1/whoami` and requires an
authenticated rung-1 key with exactly `read`, `provision`, and `teardown`
scopes; exactly one accessible project matching `CONFORMANCE_PROJECT_ID`; a
`scratch` environment; and a budget cap equal to the expected value. That
expected cap defaults to $25 and may only be overridden to an integer from $1
through $25. A preflight mismatch performs no mutation. Discovery requests
remain anonymous even in this profile; the bearer credential is attached only
to the authority preflight and governed project calls. Cleanup is attempted
after launch or status failure without replacing the original failing probe.
Every target response is size-bounded, time-bounded, and fetched with redirects
disabled. Target-controlled errors are truncated and credential-shaped values
are redacted before they enter the result.

The governed profile refuses plaintext HTTP before sending any request. Wire
and anonymous profiles may still target HTTP development servers because they
never transmit a credential or perform an authorized mutation.

## What it checks

- success and error responses validate against the bundled Draft 2020-12
  envelope schema;
- every error names a namespaced `blockedBy` gate and exposes a legitimate
  machine-readable resolution when one exists;
- the human-only approval route never tells an agent to authenticate as the
  human;
- anonymous domain search returns a conforming success envelope;
- public discovery documents, OpenAPI, transparency, MCP lifecycle, tool
  catalog parity, typed results, and semantic errors agree;
- with explicit governed authority, lifecycle responses satisfy the bundled
  mutation or actionable envelope schema plus targeted semantic checks: quote,
  launch, and teardown include receipt, undo, budget headroom, and next actions;
  actionable status teaches its next step; and the disposable teardown → quote
  → launch → status → teardown loop completes.

The output includes the exact checker version and SHA-256 digest of the schema
used for the wire grade. Standalone output is explicitly marked **unsigned and
unpublished**. SproutPad's operator-controlled report signing, append-only
ingestion, and publication workflows are separate; running this package does
not create or impersonate an official SproutPad attestation.

## Reproduce development checks

```bash
npm ci
npm test
npm run pack:check
npx --yes . --help
```

This directory is intentionally self-contained so it can be extracted as the
public `SproutPad/conformance` repository without exposing the private product
monorepo. Its workflows pin third-party actions by commit. The release workflow
installs with dependency lifecycle scripts disabled, tests and packs without
privilege, then hands a checksummed tarball to a separate `npm`
environment-approved job. Only that minimal job receives GitHub OIDC authority;
it has no source checkout, performs no install, and publishes with lifecycle
scripts disabled. There is deliberately no npm token fallback in the workflow.

### One-time npm bootstrap

npm does not let an owner configure a trusted publisher for a package that does
not exist yet. Creating `@sproutpad/conformance` therefore required one manual,
owner-approved bootstrap publication before `publish.yml` can use OIDC. That
bootstrap (`0.0.0-oidc-bootstrap.0` on tag `bootstrap`) is done; subsequent
releases use the manually dispatched, environment-approved OIDC workflow (or
owner MFA publish when OIDC is unavailable). Configure the trusted publisher
for organization `SproutPad`, repository `conformance`, workflow `publish.yml`,
GitHub environment `npm`, and the `npm publish` allowed action.

## License

The executable checker code is MIT licensed under `LICENSE`. The bundled
`spec/envelope.schema.json` is CC BY 4.0 under `spec/LICENSE.md`. Package
metadata uses the compound SPDX expression `MIT AND CC-BY-4.0` because both
file-level terms apply to the distributed tarball.
