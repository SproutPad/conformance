# SproutPad conformance checker

> **Release status:** extraction candidate. The public repository and npm
> package are not published yet. The commands below become valid only after an
> owner-approved release.

An independently runnable checker for SproutPad's public wire contract,
discovery surfaces, MCP contract, and optional governed scratch loop. The
default profile is credential-free. It grades responses against the schema
bundled with this package; a target cannot make itself pass by serving a weaker
schema.

## Run it

```bash
npx @sproutpad/conformance@0.1.0 --base-url https://api.example.com
```

That runs the `anonymous` profile: wire-envelope probes plus public discovery,
MCP initialization/tool parity, structured errors, and anonymous search. For
the smaller envelope-only grade:

```bash
npx @sproutpad/conformance@0.1.0 \
  --profile wire \
  --base-url https://api.example.com
```

Machine-readable output:

```bash
npx @sproutpad/conformance@0.1.0 \
  --base-url https://api.example.com \
  --json \
  --output conformance.json
```

The command exits `0` only when every required probe passes. `wire` and
`anonymous` use no account or API key. Their probes exercise anonymous reads
and deliberately rejected requests; they do not purchase, provision, approve,
or tear down resources.

## Governed scratch profile

`governed` is deliberately harder to invoke because it mutates one project.
It first tears that project down, proves the inventory is empty, quotes and
launches a disposable scratch service, checks live status, and tears the
project down again. Never point it at a customer or shared project.

The CLI reads credentials only from the environment; there are no credential
CLI flags. Use a dedicated narrow key/project and bind the destructive
confirmation to both the canonical HTTPS target origin and that exact project
id:

```bash
export CONFORMANCE_AGENT_KEY='agk_...'
export CONFORMANCE_PROJECT_ID='prj_dedicated_disposable_eval'
export CONFORMANCE_SCRATCH_SUFFIX='scratch.example.com'
export CONFORMANCE_TARGET_ORIGIN='https://api.example.com'
export CONFORMANCE_GOVERNED_CONFIRM="TEARDOWN:${CONFORMANCE_TARGET_ORIGIN}:${CONFORMANCE_PROJECT_ID}"
# Optional only when the disposable project's cap is below the $25 default:
# export CONFORMANCE_EXPECTED_BUDGET_USD='5'

npx @sproutpad/conformance@0.1.0 \
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
not exist yet. Creating `@sproutpad/conformance` therefore requires one manual,
owner-approved bootstrap publication before `publish.yml` can use OIDC:

1. Extract this directory into the public `SproutPad/conformance` repository
   and review the exact commit to release.
2. Authenticate an npm owner account protected by MFA using an interactive
   login or a short-lived granular credential; never add that credential to
   GitHub. In a clean temporary checkout, create and inspect a non-production
   prerelease tarball without committing the temporary version change:

   ```bash
   npm version 0.0.0-oidc-bootstrap.0 --no-git-tag-version --ignore-scripts
   npm ci --ignore-scripts
   npm test
   mkdir release
   npm pack --ignore-scripts --pack-destination release
   shasum -a 256 release/*.tgz
   npm publish release/*.tgz --access public --tag bootstrap --ignore-scripts
   ```

3. In the new package's npm settings, configure the trusted publisher for
   organization `SproutPad`, repository `conformance`, workflow
   `publish.yml`, GitHub environment `npm`, and the `npm publish` allowed
   action. Configure that environment with required reviewers and
   deployment-branch restrictions.
4. Sign out or revoke the bootstrap credential. From then on, publish reviewed
   versions only through the manually dispatched, environment-approved OIDC
   workflow. After its first successful run, set npm publishing access to
   require 2FA and disallow traditional tokens.

The bootstrap prerelease intentionally leaves `0.1.0` available for the first
normal, provenance-bearing workflow release. It is a one-time package-creation
step, not a token-based fallback path for later versions.

## License

The executable checker code is MIT licensed under `LICENSE`. The bundled
`spec/envelope.schema.json` is CC BY 4.0 under `spec/LICENSE.md`. Package
metadata uses the compound SPDX expression `MIT AND CC-BY-4.0` because both
file-level terms apply to the distributed tarball.
