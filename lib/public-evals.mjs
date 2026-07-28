import { isDeepStrictEqual } from "node:util";
import {
  boundedRequest,
  canonicalBaseUrl,
  cleanError,
  parseJsonText,
  requireGovernedHttps,
} from "./http.mjs";
import { loadEnvelopeContract } from "./schema.mjs";

export const MCP_CONFORMANCE_PROTOCOL_VERSION = "2025-11-25";
export const MCP_TOOL_CATALOG_FORMAT_VERSION = "3";

export const DISCOVERY_PROBE_IDS_V1 = [
  "discovery.llms_txt",
  "discovery.mcp_manifest",
  "discovery.openapi",
  "discovery.agents_md",
  "discovery.spec",
  "discovery.transparency",
  "anon.search_domains",
  "governance.structured_error_unauthenticated",
];

export const MCP_CONFORMANCE_PROBE_IDS = [
  "discovery.mcp_tool_catalog",
  "mcp.initialize_anonymous",
  "mcp.tools_list_catalog_parity",
  "mcp.help_result_contract",
  "mcp.semantic_error_contract",
];

export const DISCOVERY_PROBE_IDS_V2 = [
  "discovery.llms_txt",
  "discovery.mcp_manifest",
  ...MCP_CONFORMANCE_PROBE_IDS,
  "discovery.openapi",
  "discovery.agents_md",
  "discovery.spec",
  "discovery.transparency",
  "anon.search_domains",
  "governance.structured_error_unauthenticated",
];

/** Current public evaluator inventory. Signed runners choose v1/v2 explicitly. */
export const DISCOVERY_PROBE_IDS = DISCOVERY_PROBE_IDS_V2;

/**
 * Ordinary public agent-facing mutations governed by the universal §3.1
 * success contract. Fake-money sandbox transitions, read-like POSTs,
 * conformance ingestion, human decisions, and deny-only shims are excluded.
 */
export const PUBLIC_MUTATION_OPERATIONS = Object.freeze([
  ["POST", "/v1/signup"],
  ["POST", "/v1/signup/poll"],
  ["POST", "/v1/billing/setup-link"],
  ["POST", "/v1/billing/poll"],
  ["POST", "/v1/quotes"],
  ["POST", "/v1/projects"],
  ["POST", "/v1/domain-connections"],
  ["POST", "/v1/domain-connections/{id}/check"],
  ["POST", "/v1/domains/{domain}/dns"],
  ["POST", "/v1/projects/{id}/assets"],
  ["POST", "/v1/projects/{id}/launch"],
  ["POST", "/v1/projects/{id}/teardown"],
  ["POST", "/v1/domains/{domain}/apply-registrant"],
  ["POST", "/v1/budget-requests"],
  ["POST", "/v1/projects/{id}/email"],
  ["POST", "/v1/projects/{id}/emails/send"],
  ["POST", "/v1/projects/{id}/domains/attach"],
  ["POST", "/v1/projects/{id}/domains/detach"],
  ["POST", "/v1/projects/{id}/addresses/attach"],
  ["POST", "/v1/projects/{id}/addresses/detach"],
  ["POST", "/v1/services/move"],
  ["POST", "/v1/projects/{id}/services/remove"],
  ["POST", "/v1/projects/{id}/purpose"],
]);

function assertOpenApiContract(condition, message) {
  if (!condition) throw new Error(message);
}

function schemaRequiresDataCarrier(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  if (
    schema.type === "object" &&
    Array.isArray(schema.required) &&
    schema.required.includes("data") &&
    schema.properties?.data
  ) {
    return true;
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (
      Array.isArray(schema[key]) &&
      schema[key].some((part) => schemaRequiresDataCarrier(part))
    ) {
      return true;
    }
  }
  return false;
}

/** Envelope-level only — nested `data.*` fields are operation-owned. */
function schemaDeclaresTopLevelEnvelopeField(schema, field) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  if (
    schema.properties &&
    typeof schema.properties === "object" &&
    Object.prototype.hasOwnProperty.call(schema.properties, field)
  ) {
    return true;
  }
  if (Array.isArray(schema.required) && schema.required.includes(field)) {
    return true;
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (
      Array.isArray(schema[key]) &&
      schema[key].some((part) =>
        schemaDeclaresTopLevelEnvelopeField(part, field),
      )
    ) {
      return true;
    }
  }
  return false;
}

function includesEvery(values, expected) {
  return (
    Array.isArray(values) && expected.every((value) => values.includes(value))
  );
}

function hasExactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function hasExactValues(value, expected) {
  return (
    Array.isArray(value) &&
    [...value].sort().join("\0") === [...expected].sort().join("\0")
  );
}

/** Verify the public OpenAPI document structurally covers every §3.1 mutation. */
export function assertPublicMutationOpenApiContract(document) {
  const paths = document?.paths;
  const schemas = document?.components?.schemas;
  assertOpenApiContract(
    paths && typeof paths === "object" && !Array.isArray(paths),
    "OpenAPI document omitted paths",
  );
  assertOpenApiContract(
    schemas && typeof schemas === "object" && !Array.isArray(schemas),
    "OpenAPI document omitted component schemas",
  );

  const expectedKeys = new Set(
    PUBLIC_MUTATION_OPERATIONS.map(([method, path]) => `${method} ${path}`),
  );
  const markedKeys = new Set();
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) {
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (
        operation &&
        typeof operation === "object" &&
        !Array.isArray(operation) &&
        operation["x-sproutpad-operation-class"] === "mutation"
      ) {
        markedKeys.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  const missingMarkers = [...expectedKeys].filter(
    (key) => !markedKeys.has(key),
  );
  const unexpectedMarkers = [...markedKeys].filter(
    (key) => !expectedKeys.has(key),
  );
  assertOpenApiContract(
    missingMarkers.length === 0 && unexpectedMarkers.length === 0,
    `OpenAPI mutation inventory mismatch (missing: ${missingMarkers.join(", ") || "none"}; unexpected: ${unexpectedMarkers.join(", ") || "none"})`,
  );

  assertOpenApiContract(
    schemas.AgentAction &&
      (schemas.AgentAction.oneOf || schemas.AgentAction.$ref),
    "OpenAPI omits the typed AgentAction continuation schema",
  );

  for (const [method, path] of PUBLIC_MUTATION_OPERATIONS) {
    const operation = paths[path]?.[method.toLowerCase()];
    const successes = Object.entries(operation?.responses ?? {}).filter(
      ([status]) => /^2\d\d$/.test(status),
    );
    assertOpenApiContract(
      successes.length > 0,
      `${method} ${path} omitted a documented 2xx response`,
    );
    for (const [status, response] of successes) {
      const schema = response?.content?.["application/json"]?.schema;
      assertOpenApiContract(
        schemaRequiresDataCarrier(schema),
        `${method} ${path} ${status} is not a descriptor-owned { data } carrier`,
      );
      assertOpenApiContract(
        !schemaDeclaresTopLevelEnvelopeField(schema, "nextActions"),
        `${method} ${path} ${status} still declares prose nextActions`,
      );
      assertOpenApiContract(
        !schemaDeclaresTopLevelEnvelopeField(schema, "resolution"),
        `${method} ${path} ${status} still declares generic resolution on the success envelope`,
      );
    }
  }
}

/** Read the target's public report schema as an explicit ingestion capability. */
export function advertisedConformanceReportVersions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const properties = value.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return [];
  const schemaVersion = properties.schemaVersion;
  if (
    !schemaVersion ||
    typeof schemaVersion !== "object" ||
    Array.isArray(schemaVersion)
  )
    return [];
  if (typeof schemaVersion.const === "string") return [schemaVersion.const];
  return Array.isArray(schemaVersion.enum)
    ? schemaVersion.enum.filter((version) => typeof version === "string")
    : [];
}

export const GOVERNED_PROBE_IDS = [
  "loop.quote",
  "loop.launch",
  "loop.status_live",
  "loop.teardown",
];

const REQUIRED_GOVERNED_SCOPES = ["provision", "read", "teardown"];
const MAX_GOVERNED_BUDGET_CAP_USD = 25;

// The governed loop deliberately exercises the lowest-risk deploy primitive:
// an audited, static edge bundle. It is not a service starter and avoids
// granting the unattended conformance key authority to approve a container
// image that can execute arbitrary code.
const CONFORMANCE_STATIC_FILES = Object.freeze([
  Object.freeze({
    path: "index.html",
    contentBase64:
      "PCFkb2N0eXBlIGh0bWw+PGh0bWw+PGhlYWQ+PHRpdGxlPlNwcm91dFBhZCBjb25mb3JtYW5jZTwvdGl0bGU+PC9oZWFkPjxib2R5PkNvbmZvcm1hbmNlIGNhbmFyeTwvYm9keT48L2h0bWw+",
  }),
]);

export async function runPublicEvals(options = {}) {
  const baseUrl = canonicalBaseUrl(options.baseUrl);
  const agentKey = options.agentKey;
  const projectId = options.projectId;
  const fetchImpl = options.fetchImpl ?? fetch;
  // Reset/cleanup and launch have different bounded service contracts. A
  // production launch may legitimately spend 15 minutes in the workflow's TLS
  // issuance window after compute and DNS have already converged, so applying
  // the shorter teardown budget to launch strands an admitted mutation while
  // the runner publishes a false timeout.
  const taskTimeoutMs = options.taskTimeoutMs ?? 600_000;
  const resetTimeoutMs = options.resetTimeoutMs ?? taskTimeoutMs;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? taskTimeoutMs;
  const launchTimeoutMs = options.launchTimeoutMs ?? taskTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const responseLimitBytes = options.responseLimitBytes ?? 1_000_000;
  const includeMcpContract = options.includeMcpContract ?? true;
  const mcpTimeoutMs = options.mcpTimeoutMs ?? 15_000;
  const mcpResponseLimitBytes =
    options.mcpResponseLimitBytes ?? 2 * 1024 * 1024;
  const scratchDomainSuffix =
    options.scratchDomainSuffix ?? "scratch.sproutpad.io";
  const expectedBudgetCapUsd = options.expectedBudgetCapUsd ?? 25;
  if (
    (agentKey !== undefined && typeof agentKey !== "string") ||
    (projectId !== undefined && typeof projectId !== "string")
  ) {
    throw new Error("governed credentials must be strings");
  }
  if (agentKey && projectId) {
    requireGovernedHttps(baseUrl);
    if (!/^prj_[A-Za-z0-9_-]{3,128}$/.test(projectId)) {
      throw new Error("governed profile requires a valid project id");
    }
    if (!/^agk_[^.\s]+\.[^.\s]+$/.test(agentKey)) {
      throw new Error("governed profile requires a valid agent key");
    }
  }
  const envelopeContract =
    agentKey && projectId ? await loadEnvelopeContract() : undefined;
  if (
    !Number.isSafeInteger(expectedBudgetCapUsd) ||
    expectedBudgetCapUsd < 1 ||
    expectedBudgetCapUsd > MAX_GOVERNED_BUDGET_CAP_USD
  ) {
    throw new Error(
      `expected governed budget must be an integer from 1 to ${MAX_GOVERNED_BUDGET_CAP_USD} USD`,
    );
  }
  if (
    typeof scratchDomainSuffix !== "string" ||
    scratchDomainSuffix.length > 253 ||
    scratchDomainSuffix.includes("..") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(scratchDomainSuffix) ||
    scratchDomainSuffix.split(".").some((label) => label.length > 63)
  ) {
    throw new Error("scratch domain suffix must be a lowercase DNS name");
  }
  const results = [];

  async function scenario(id, opts, fn) {
    const spec = opts.spec ? { spec: opts.spec } : {};
    if (opts.requiresKey && (!agentKey || !projectId)) {
      results.push({
        id,
        ...spec,
        status: "not_run",
        error: "governed profile credentials not supplied",
      });
      return;
    }
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({
        id,
        ...spec,
        status: "pass",
        latencyMs: Date.now() - started,
        ...(detail ? { detail } : {}),
      });
    } catch (error) {
      results.push({
        id,
        ...spec,
        status: "fail",
        latencyMs: Date.now() - started,
        error: cleanError(error, [agentKey]),
      });
    }
  }

  async function request(
    method,
    path,
    { body, headers, authenticated = false } = {},
  ) {
    if (authenticated && !agentKey) {
      throw new Error("authenticated request attempted without an agent key");
    }
    const { response, text } = await boundedRequest(
      fetchImpl,
      `${baseUrl}${path}`,
      {
        method,
        headers: {
          accept: "application/json, text/plain;q=0.9",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(authenticated ? { authorization: `Bearer ${agentKey}` } : {}),
          ...(headers ?? {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      {
        label: path,
        limitBytes: responseLimitBytes,
        timeoutMs: requestTimeoutMs,
      },
    );
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, text, json };
  }
  const expect = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const isObject = (value) =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  function assertSuccessEnvelope(label, body, operation = "read") {
    if (!envelopeContract) {
      throw new Error(
        `${label} attempted governed validation without credentials`,
      );
    }
    envelopeContract.assert("successEnvelope", body, `${label} response`);
    if (operation === "actionable") {
      envelopeContract.assert(
        "actionableSuccessEnvelope",
        body,
        `${label} response`,
      );
    }
    if (operation === "mutation") {
      envelopeContract.assert(
        "mutatingSuccessEnvelope",
        body,
        `${label} response`,
      );
    }
    if (operation === "inventoryRead") {
      try {
        envelopeContract.assert(
          "inventoryReadSuccessEnvelope",
          body,
          `${label} response`,
        );
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `${detail} (GET /status must be inventoryReadSuccessEnvelope: no top-level or data.actions; see envelope.schema.json#/$defs/inventoryReadSuccessEnvelope)`,
        );
      }
    }
  }

  async function anonymousJsonRequest(method, path, { body, headers } = {}) {
    const { response, text } = await boundedRequest(
      fetchImpl,
      `${baseUrl}${path}`,
      {
        method,
        headers: {
          accept: "application/json, text/event-stream",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(headers ?? {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      {
        label: path,
        limitBytes: mcpResponseLimitBytes,
        timeoutMs: mcpTimeoutMs,
      },
    );
    const json = parseJsonText(text, path);
    return { status: response.status, json };
  }

  let mcpRequestId = 0;
  let negotiatedProtocolVersion = MCP_CONFORMANCE_PROTOCOL_VERSION;
  async function mcpRpc(method, params = {}) {
    const id = `public-conformance-${++mcpRequestId}`;
    const { status, json } = await anonymousJsonRequest("POST", "/mcp", {
      body: { jsonrpc: "2.0", id, method, params },
      headers:
        method === "initialize"
          ? {}
          : { "mcp-protocol-version": negotiatedProtocolVersion },
    });
    expect(status === 200, `${method} returned HTTP ${status}`);
    expect(isObject(json), `${method} response was not an object`);
    expect(json.jsonrpc === "2.0", `${method} response was not JSON-RPC 2.0`);
    expect(json.id === id, `${method} response id did not match`);
    expect(
      json.error === undefined,
      `${method} returned JSON-RPC error ${isObject(json.error) && Number.isInteger(json.error.code) ? json.error.code : "unknown"}`,
    );
    expect(isObject(json.result), `${method} response result was missing`);
    return json.result;
  }

  async function mcpNotify(method, params = {}) {
    const { status, json } = await anonymousJsonRequest("POST", "/mcp", {
      body: { jsonrpc: "2.0", method, params },
      headers: { "mcp-protocol-version": negotiatedProtocolVersion },
    });
    expect(status === 202, `${method} notification returned HTTP ${status}`);
    expect(
      json === undefined,
      `${method} notification returned a response body`,
    );
  }

  let manifestPromise;
  function loadMcpManifest() {
    manifestPromise ??= (async () => {
      const { status, json } = await anonymousJsonRequest(
        "GET",
        "/.well-known/mcp.json",
      );
      expect(status === 200, `MCP manifest returned HTTP ${status}`);
      expect(isObject(json), "MCP manifest was not an object");
      expect(
        json.url === `${baseUrl}/mcp`,
        "MCP manifest URL was not canonical",
      );
      return json;
    })();
    return manifestPromise;
  }

  let catalogPromise;
  function loadMcpToolCatalog() {
    catalogPromise ??= (async () => {
      const [manifest, response] = await Promise.all([
        loadMcpManifest(),
        anonymousJsonRequest("GET", "/.well-known/mcp-tools.json"),
      ]);
      expect(
        response.status === 200,
        `MCP tool catalog returned HTTP ${response.status}`,
      );
      const catalog = response.json;
      expect(isObject(catalog), "MCP tool catalog was not an object");
      // The format version is exported so the monorepo producer parity gate and
      // standalone checker fixtures consume the same public checker contract.
      // Legacy schemaVersion/formatVersion "1" and descriptor format "2" are gone.
      expect(
        catalog.formatVersion === MCP_TOOL_CATALOG_FORMAT_VERSION,
        "MCP tool catalog schema changed",
      );
      expect(
        catalog.mcp === `${baseUrl}/mcp`,
        "MCP catalog URL was not canonical",
      );
      expect(
        manifest.mcpDiscovery === `${baseUrl}/.well-known/mcp-tools.json`,
        "MCP manifest did not link the canonical tool catalog via mcpDiscovery",
      );
      expect(
        typeof manifest.toolCatalog !== "string",
        "MCP manifest retained retired toolCatalog alias",
      );
      expect(Array.isArray(catalog.tools), "MCP tool catalog omitted tools");
      expect(catalog.tools.length > 0, "MCP tool catalog was empty");
      expect(
        manifest.toolCount === catalog.tools.length,
        "MCP manifest and catalog tool counts drifted",
      );
      expect(
        typeof catalog.contractDigest === "string" &&
          catalog.contractDigest.length > 0,
        "MCP catalog omitted contractDigest",
      );
      expect(
        isObject(catalog.coverage) && catalog.coverage.complete === true,
        "MCP catalog coverage was incomplete",
      );

      const names = [];
      const requiredAnnotationKeys = [
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
      ];
      for (const tool of catalog.tools) {
        expect(isObject(tool), "MCP catalog contained a malformed tool");
        expect(
          typeof tool.operationId === "string" && tool.operationId.length > 0,
          "MCP catalog operationId was invalid",
        );
        expect(
          typeof tool.title === "string" && tool.title.length > 0,
          `${tool.operationId}: catalog title was invalid`,
        );
        expect(
          typeof tool.description === "string" && tool.description.length > 0,
          `${tool.operationId}: catalog description was invalid`,
        );
        expect(
          isObject(tool.authorization) &&
            ["anonymous", "optional", "required"].includes(
              tool.authorization.auth,
            ) &&
            Array.isArray(tool.authorization.scopes) &&
            tool.authorization.scopes.every(
              (scope) => typeof scope === "string",
            ),
          `${tool.operationId}: catalog authorization was invalid`,
        );
        expect(
          isObject(tool.behavior) &&
            ["read", "reserve", "credential", "write", "delete"].includes(
              tool.behavior.effect,
            ) &&
            ["none", "client_key", "state_machine"].includes(
              tool.behavior.idempotency,
            ) &&
            ["none", "returns_handle", "polls_handle"].includes(
              tool.behavior.taskMode,
            ),
          `${tool.operationId}: catalog behavior was invalid`,
        );
        expect(
          isObject(tool.lifecycle) &&
            ["active", "unavailable"].includes(tool.lifecycle.status),
          `${tool.operationId}: catalog lifecycle was invalid`,
        );
        expect(
          isObject(tool.bindings) && isObject(tool.bindings.mcp),
          `${tool.operationId}: catalog omitted MCP binding`,
        );
        const mcpBinding = tool.bindings.mcp;
        expect(
          typeof mcpBinding.toolName === "string" &&
            mcpBinding.toolName.length > 0,
          `${tool.operationId}: catalog MCP toolName was invalid`,
        );
        expect(
          typeof mcpBinding.description === "string" &&
            mcpBinding.description.length > 0,
          `${tool.operationId}: catalog MCP description was invalid`,
        );
        expect(
          isObject(mcpBinding.annotations) &&
            isDeepStrictEqual(
              Object.keys(mcpBinding.annotations).sort(),
              requiredAnnotationKeys,
            ) &&
            Object.values(mcpBinding.annotations).every(
              (annotation) => typeof annotation === "boolean",
            ),
          `${tool.operationId}: catalog annotations were invalid`,
        );
        names.push(mcpBinding.toolName);
      }
      expect(
        new Set(names).size === names.length,
        "MCP catalog names repeated",
      );
      expect(
        isDeepStrictEqual(names, [...names].sort()),
        "MCP catalog ordering was not stable",
      );
      for (const requiredTool of [
        "help",
        "estimate",
        "verify_architecture",
        "verify_sandbox_proof",
      ]) {
        expect(
          names.includes(requiredTool),
          `MCP catalog omitted ${requiredTool}`,
        );
      }
      return catalog;
    })();
    return catalogPromise;
  }

  async function listMcpTools() {
    const tools = [];
    const seenCursors = new Set();
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await mcpRpc("tools/list", cursor ? { cursor } : {});
      expect(Array.isArray(result.tools), "tools/list omitted its tools array");
      tools.push(...result.tools);
      expect(
        tools.length <= 1_000,
        "tools/list exceeded the public tool limit",
      );
      const nextCursor = result.nextCursor;
      if (nextCursor === undefined) return tools;
      expect(
        typeof nextCursor === "string" && nextCursor.length > 0,
        "tools/list returned an invalid cursor",
      );
      expect(!seenCursors.has(nextCursor), "tools/list repeated a cursor");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("tools/list exceeded the pagination limit");
  }

  function decodeMcpToolResult(toolName, result) {
    expect(
      isObject(result.structuredContent),
      `${toolName} omitted structuredContent`,
    );
    expect(Array.isArray(result.content), `${toolName} omitted content`);
    const textBlock = result.content.find(
      (item) =>
        isObject(item) && item.type === "text" && typeof item.text === "string",
    );
    expect(textBlock, `${toolName} omitted its JSON text fallback`);
    let textPayload;
    try {
      textPayload = JSON.parse(textBlock.text);
    } catch {
      throw new Error(`${toolName} returned a non-JSON text fallback`);
    }
    expect(
      isObject(textPayload),
      `${toolName} text fallback was not an object`,
    );
    expect(
      isDeepStrictEqual(result.structuredContent, textPayload),
      `${toolName} structured and text results drifted`,
    );
    return result.structuredContent;
  }

  function ownedTaskFromEnvelope(body) {
    const data = body?.data;
    // Nested-only: flat data.status / data.taskId are not a task admission.
    return isObject(data?.task) ? data.task : undefined;
  }

  function admittedTaskId(body) {
    const data = body?.data;
    if (!isObject(data?.task)) return undefined;
    if (typeof data.task.taskId === "string" && data.task.taskId.length > 0) {
      return data.task.taskId;
    }
    return undefined;
  }

  function assertTaskAdmissionMutation(label, body) {
    assertSuccessEnvelope(label, body, "actionable");
    const data = body?.data;
    expect(isObject(data?.task), `${label} omitted owned task projection`);
    const taskId = data.task.taskId;
    expect(
      typeof taskId === "string" && taskId.length > 0,
      `${label} omitted task.taskId`,
    );
    const admission = data?.result?.admission;
    expect(isObject(admission), `${label} omitted result.admission`);
    const receipt = admission.receipt;
    expect(isObject(receipt), `${label} omitted admission receipt`);
    expect(
      typeof receipt.action === "string" && receipt.action.length > 0,
      `${label} admission receipt omitted action`,
    );
    expect(
      typeof receipt.oneTimeUsd === "number" &&
        Number.isFinite(receipt.oneTimeUsd) &&
        receipt.oneTimeUsd >= 0,
      `${label} admission receipt oneTimeUsd was invalid`,
    );
    expect(
      typeof receipt.monthlyDeltaUsd === "number" &&
        Number.isFinite(receipt.monthlyDeltaUsd),
      `${label} admission receipt monthlyDeltaUsd was invalid`,
    );
    expect(
      Array.isArray(receipt.resources) && receipt.resources.length > 0,
      `${label} admission receipt omitted resources`,
    );
    expect(
      receipt.resources.every(
        (resource) =>
          isObject(resource) &&
          typeof resource.kind === "string" &&
          resource.kind.length > 0 &&
          typeof resource.provider === "string" &&
          resource.provider.length > 0 &&
          typeof resource.externalId === "string" &&
          resource.externalId.length > 0,
      ),
      `${label} admission receipt resources were malformed`,
    );
    expect(
      receipt.resources.some((resource) => resource.externalId === taskId),
      `${label} admission receipt did not reference task.taskId`,
    );
    const undo = admission.undo;
    expect(isObject(undo), `${label} omitted admission undo`);
    expect(
      (undo.irreversible === false &&
        typeof undo.command === "string" &&
        undo.command.length > 0) ||
        (undo.irreversible === true && undo.command === null),
      `${label} admission undo was invalid`,
    );
    expect(
      typeof admission.budgetRemainingUsd === "number" &&
        Number.isFinite(admission.budgetRemainingUsd) &&
        admission.budgetRemainingUsd >= 0,
      `${label} admission budgetRemainingUsd was invalid`,
    );
    const poll = data.actions?.[0];
    expect(
      isObject(poll) &&
        poll.kind === "tool" &&
        poll.tool === "get_task" &&
        poll.arguments?.taskId === taskId,
      `${label} poll action must target task.taskId`,
    );
  }

  async function pollTask(taskId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { status, json } = await request("GET", `/v1/tasks/${taskId}`, {
        authenticated: true,
      });
      expect(status === 200, `task poll returned ${status}`);
      assertSuccessEnvelope("task poll", json);
      const task = ownedTaskFromEnvelope(json);
      expect(isObject(task), `task poll omitted owned task for ${taskId}`);
      expect(
        task.taskId === taskId,
        `task poll returned ${String(task.taskId)} for requested ${taskId}`,
      );
      if (task.status === "completed") return task;
      if (task.status === "failed")
        throw new Error(
          `task failed: ${JSON.stringify(task.error ?? task).slice(0, 300)}`,
        );
      if (task.status === "input_required")
        throw new Error("governed canary hit an unexpected approval gate");
      if (Date.now() > deadline)
        throw new Error(
          `task ${taskId} still ${task.status} after ${timeoutMs}ms`,
        );
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  function newMutationAdmission(label) {
    return { label, phase: "not_started" };
  }

  async function dispatchAndReconcileTaskMutation(
    label,
    admission,
    path,
    options,
  ) {
    admission.phase = "requesting";
    let response;
    try {
      response = await request("POST", path, options);
    } catch (error) {
      admission.phase = "ambiguous";
      admission.reason = "request failed after dispatch may have begun";
      throw error;
    }

    const accepted = response.status >= 200 && response.status < 300;
    if (!accepted) {
      admission.phase =
        response.status >= 400 && response.status < 500
          ? "rejected"
          : "ambiguous";
      admission.reason =
        admission.phase === "rejected"
          ? `HTTP ${response.status} rejected the request`
          : `HTTP ${response.status} did not prove the request was rejected`;
      throw new Error(`${label} returned ${response.status}`);
    }

    const taskId = admittedTaskId(response.json);
    if (typeof taskId !== "string" || taskId.length === 0) {
      admission.phase = "ambiguous";
      admission.reason = `accepted HTTP ${response.status} response omitted nested data.task.taskId`;
      throw new Error(
        `${label} returned ${response.status} without nested data.task.taskId; admission is ambiguous`,
      );
    }

    admission.phase = "accepted";
    admission.taskId = taskId;
    let contractError;
    try {
      // Teardown/launch must be nested task-admission only (no flat dual-accept).
      assertTaskAdmissionMutation(label, response.json);
    } catch (error) {
      contractError = error;
    }

    try {
      const timeoutMs =
        label === "launch"
          ? launchTimeoutMs
          : label === "pre-run reset"
            ? resetTimeoutMs
            : label === "teardown"
              ? cleanupTimeoutMs
              : taskTimeoutMs;
      await pollTask(taskId, timeoutMs);
      admission.phase = "settled";
      admission.reason = undefined;
    } catch (error) {
      admission.phase = "unresolved";
      admission.reason = cleanError(error, [agentKey]);
      throw error;
    }

    return { ...response, taskId, contractError };
  }

  const unsafeAdmissionPhases = new Set([
    "requesting",
    "accepted",
    "ambiguous",
    "unresolved",
  ]);

  function cleanupRefusal(admission) {
    const reason = admission.reason ? ` (${admission.reason})` : "";
    return `${admission.label} admission is ${admission.phase}${reason}; refusing a fresh teardown with a different Idempotency-Key`;
  }

  await scenario("discovery.llms_txt", {}, async () => {
    const { status, text } = await request("GET", "/llms.txt");
    expect(
      status === 200 && text.includes("SproutPad"),
      `unexpected response (${status})`,
    );
  });
  await scenario("discovery.mcp_manifest", {}, async () => {
    await loadMcpManifest();
  });
  if (includeMcpContract) {
    await scenario(
      "discovery.mcp_tool_catalog",
      { spec: "MCP tool discovery contract" },
      async () => {
        const catalog = await loadMcpToolCatalog();
        return { toolCount: catalog.tools.length };
      },
    );
    await scenario(
      "mcp.initialize_anonymous",
      { spec: `MCP ${MCP_CONFORMANCE_PROTOCOL_VERSION} lifecycle` },
      async () => {
        const result = await mcpRpc("initialize", {
          protocolVersion: MCP_CONFORMANCE_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "sproutpad-public-conformance", version: "1" },
        });
        expect(
          result.protocolVersion === MCP_CONFORMANCE_PROTOCOL_VERSION,
          `initialize negotiated unexpected protocol ${String(result.protocolVersion)}`,
        );
        expect(
          isObject(result.serverInfo) && result.serverInfo.name === "sproutpad",
          "initialize returned unexpected server identity",
        );
        expect(
          typeof result.serverInfo.version === "string" &&
            result.serverInfo.version.length > 0,
          "initialize omitted the server version",
        );
        expect(
          isObject(result.capabilities) && isObject(result.capabilities.tools),
          "initialize omitted the tools capability",
        );
        negotiatedProtocolVersion = result.protocolVersion;
        await mcpNotify("notifications/initialized");
        return { protocolVersion: negotiatedProtocolVersion };
      },
    );
    await scenario(
      "mcp.tools_list_catalog_parity",
      { spec: "MCP tools/list metadata parity" },
      async () => {
        const [catalog, runtimeTools] = await Promise.all([
          loadMcpToolCatalog(),
          listMcpTools(),
        ]);
        const catalogByName = new Map(
          catalog.tools.map((tool) => {
            const toolName = tool.bindings?.mcp?.toolName;
            expect(
              typeof toolName === "string" && toolName.length > 0,
              `${String(tool.operationId)}: catalog MCP toolName missing`,
            );
            return [toolName, tool];
          }),
        );
        const runtimeByName = new Map();
        for (const tool of runtimeTools) {
          expect(
            isObject(tool) && typeof tool.name === "string",
            "tools/list contained a malformed tool",
          );
          expect(
            !runtimeByName.has(tool.name),
            `tools/list repeated ${tool.name}`,
          );
          runtimeByName.set(tool.name, tool);
        }
        expect(
          isDeepStrictEqual(
            [...runtimeByName.keys()].sort(),
            [...catalogByName.keys()].sort(),
          ),
          "tools/list names drifted from the public catalog",
        );
        for (const [name, contract] of catalogByName) {
          const tool = runtimeByName.get(name);
          expect(tool.title === contract.title, `${name}: title drifted`);
          expect(
            tool.description === contract.bindings.mcp.description,
            `${name}: description drifted`,
          );
          expect(
            isDeepStrictEqual(
              tool.annotations,
              contract.bindings.mcp.annotations,
            ),
            `${name}: annotations drifted`,
          );
          expect(
            isObject(tool.inputSchema),
            `${name}: inputSchema was missing`,
          );
          const expectsOutputSchema =
            isObject(contract.schemas?.output) &&
            contract.schemas.output.state === "complete";
          expect(
            (tool.outputSchema !== undefined) === expectsOutputSchema &&
              (!expectsOutputSchema || isObject(tool.outputSchema)),
            `${name}: outputSchema presence drifted`,
          );
        }
        return { toolCount: runtimeTools.length };
      },
    );
    await scenario(
      "mcp.help_result_contract",
      { spec: "MCP structuredContent compatibility" },
      async () => {
        const result = await mcpRpc("tools/call", {
          name: "help",
          arguments: {},
        });
        expect(result.isError !== true, "help returned a tool execution error");
        const payload = decodeMcpToolResult("help", result);
        expect(Array.isArray(payload.actions), "help omitted typed actions");
        expect(
          !Object.prototype.hasOwnProperty.call(payload, "nextActions"),
          "help must not emit retired prose nextActions",
        );
      },
    );
    await scenario(
      "mcp.semantic_error_contract",
      { spec: "MCP semantic tool errors" },
      async () => {
        const result = await mcpRpc("tools/call", {
          name: "estimate",
          arguments: { domain: "not a domain" },
        });
        expect(
          result.isError === true,
          "invalid estimate was not a tool error",
        );
        const payload = decodeMcpToolResult("estimate", result);
        expect(payload.ok === false, "invalid estimate did not set ok=false");
        expect(
          payload.code === "input:invalid_domain" &&
            payload.blockedBy === "input:invalid_domain",
          "invalid estimate returned the wrong semantic error",
        );
        expect(payload.retryable === false, "invalid estimate was retryable");
        expect(
          Array.isArray(payload.actions) &&
            payload.actions.length >= 1 &&
            payload.actions.every((action) =>
              ["tool", "url", "stop", "manual"].includes(action?.kind),
            ),
          "invalid estimate omitted typed actions",
        );
        expect(
          !Object.prototype.hasOwnProperty.call(payload, "resolution"),
          "invalid estimate must not carry generic resolution",
        );
      },
    );
  }
  await scenario("discovery.openapi", {}, async () => {
    const { status, json } = await request("GET", "/openapi.json");
    expect(status === 200 && json?.openapi, `unexpected response (${status})`);
    assertPublicMutationOpenApiContract(json);
  });
  await scenario("discovery.agents_md", {}, async () => {
    const { status, text } = await request("GET", "/agents.md");
    expect(
      status === 200 && text.includes("agents"),
      `unexpected response (${status})`,
    );
  });
  await scenario("discovery.spec", {}, async () => {
    const { status, text } = await request("GET", "/spec.md");
    expect(
      status === 200 && text.includes("Governed Agent Spend"),
      `unexpected response (${status})`,
    );
  });
  await scenario("discovery.transparency", {}, async () => {
    const { status, json } = await request("GET", "/transparency");
    expect(
      status === 200 && json?.data?.governance,
      `unexpected response (${status})`,
    );
  });
  await scenario("anon.search_domains", {}, async () => {
    const { status, json } = await request(
      "GET",
      "/v1/domains/search?query=eval-harness-demo",
    );
    expect(
      status === 200 && Array.isArray(json?.data?.results),
      `unexpected response (${status})`,
    );
  });
  await scenario(
    "governance.structured_error_unauthenticated",
    { spec: "§11.2 structured errors" },
    async () => {
      const { status, json } = await request("POST", "/v1/quotes", {
        body: { projectId: "prj_none", domain: "example.com" },
      });
      expect(status >= 400 && status < 500, `expected 4xx, got ${status}`);
      expect(
        typeof json?.blockedBy === "string",
        "error body missing blockedBy",
      );
      expect(
        typeof json?.message === "string" && json.message.length > 0,
        "error body missing message",
      );
      expect(
        typeof json?.retryable === "boolean",
        "error body missing retryable",
      );
      expect(
        Array.isArray(json?.actions) &&
          json.actions.length >= 1 &&
          json.actions.every((action) =>
            ["tool", "url", "stop", "manual"].includes(action?.kind),
          ),
        "error body missing typed actions",
      );
      expect(
        !Object.prototype.hasOwnProperty.call(json ?? {}, "resolution"),
        "agent error must not carry generic resolution",
      );
    },
  );

  const governedTargetAdmitted = results.every(
    (result) => result.status === "pass",
  );
  const runId = `eval-${Date.now().toString(36)}`;
  const scratchDomain = `${runId}.${scratchDomainSuffix}`;
  const service = "evalweb";
  let governedPreflightPassed = false;
  let governedReady = false;
  let launchCompleted = false;
  let scratchResetClean = false;
  let bundleId;
  const resetAdmission = newMutationAdmission("pre-run reset");
  const launchAdmission = newMutationAdmission("launch");
  const cleanupAdmission = newMutationAdmission("final cleanup");
  await scenario(
    "loop.quote",
    { requiresKey: true, spec: "§11.1 · §11.4" },
    async () => {
      expect(
        governedTargetAdmitted,
        "public discovery did not pass; refusing governed mutation",
      );
      const whoami = await request("GET", "/v1/whoami", {
        authenticated: true,
      });
      expect(
        whoami.status === 200,
        `authority preflight returned ${whoami.status}`,
      );
      assertSuccessEnvelope("authority preflight", whoami.json);
      const authority = whoami.json?.data;
      const scopes = Array.isArray(authority?.scopes)
        ? [...authority.scopes].sort()
        : [];
      expect(
        authority?.authenticated === true &&
          authority?.rung === 1 &&
          isDeepStrictEqual(scopes, REQUIRED_GOVERNED_SCOPES),
        "governed key must be rung 1 with exactly read, provision, and teardown scopes",
      );
      const projects = Array.isArray(authority?.projects)
        ? authority.projects
        : [];
      expect(
        projects.length === 1 &&
          projects[0]?.id === projectId &&
          projects[0]?.environment === "scratch" &&
          projects[0]?.budgetCapUsd === expectedBudgetCapUsd,
        `governed key must own exactly one $${expectedBudgetCapUsd} disposable scratch project`,
      );
      // No mutating request is permitted before the complete authority check.
      governedPreflightPassed = true;
      // This identity intentionally owns one reusable disposable project. A
      // failed prior cleanup must never be allowed to contaminate the next
      // launch: first converge the append-only ledger through the normal
      // governed teardown path, then quote against the clean project. If the
      // reset fails, loop.launch refuses to mutate anything below.
      const reset = await dispatchAndReconcileTaskMutation(
        "pre-run reset",
        resetAdmission,
        `/v1/projects/${projectId}/teardown`,
        {
          body: {
            dryRun: false,
            justification: "public conformance pre-run scratch reset",
          },
          headers: { "idempotency-key": `${runId}-reset` },
          authenticated: true,
        },
      );
      let inventoryError;
      try {
        const inventory = await request(
          "GET",
          `/v1/projects/${projectId}/resources`,
          { authenticated: true },
        );
        expect(
          inventory.status === 200,
          `post-reset inventory returned ${inventory.status}`,
        );
        assertSuccessEnvelope("post-reset inventory", inventory.json);
        const inventoryData = inventory.json?.data;
        scratchResetClean =
          Array.isArray(inventoryData?.resources) &&
          inventoryData.resources.length === 0 &&
          Array.isArray(inventoryData?.services) &&
          inventoryData.services.length === 0 &&
          Array.isArray(inventoryData?.parkedDomains) &&
          inventoryData.parkedDomains.length === 0;
        if (!scratchResetClean) {
          inventoryError = new Error(
            "governed scratch project was not empty after reset",
          );
        }
      } catch (error) {
        inventoryError = error;
      }
      if (reset.contractError) throw reset.contractError;
      if (inventoryError) throw inventoryError;

      const assets = await request("POST", `/v1/projects/${projectId}/assets`, {
        body: { files: CONFORMANCE_STATIC_FILES },
        headers: { "idempotency-key": `${runId}-assets` },
        authenticated: true,
      });
      expect(assets.status === 201, `asset staging returned ${assets.status}`);
      assertSuccessEnvelope("asset staging", assets.json, "mutation");
      expect(
        typeof assets.json?.data?.bundleId === "string" &&
          assets.json.data.bundleId.length > 0,
        "asset staging response omitted bundleId",
      );
      bundleId = assets.json.data.bundleId;

      const { status, json } = await request("POST", "/v1/quotes", {
        body: {
          projectId,
          domain: scratchDomain,
          service,
          target: "cloudflare",
        },
        headers: { "idempotency-key": `${runId}-quote` },
        authenticated: true,
      });
      expect(status === 200, `quote returned ${status}`);
      assertSuccessEnvelope("quote", json, "mutation");
      // Nested-only: live V2 quote puts the Cedar decision under data.quote.
      // Flat data.verdict is the retired pre-descriptor projection.
      const quoteDecision = isObject(json?.data?.quote) ? json.data.quote : null;
      expect(
        quoteDecision !== null,
        "quote returned 200 without nested data.quote; decision is ambiguous",
      );
      expect(
        quoteDecision.verdict === "ALLOW",
        `quote verdict ${quoteDecision.verdict}`,
      );
      governedReady = true;
      return { scratchReset: "completed", assetBundle: "staged" };
    },
  );
  await scenario(
    "loop.launch",
    { requiresKey: true, spec: "§11.1 · §11.8" },
    async () => {
      expect(
        governedReady && bundleId,
        "governed scratch reset, static bundle, and quote did not complete",
      );
      const launch = await dispatchAndReconcileTaskMutation(
        "launch",
        launchAdmission,
        `/v1/projects/${projectId}/launch`,
        {
          body: {
            domain: scratchDomain,
            target: "cloudflare",
            bundleId,
            service,
            justification:
              "public conformance canary — isolated static edge service",
          },
          headers: { "idempotency-key": `${runId}-launch` },
          authenticated: true,
        },
      );
      launchCompleted = true;
      if (launch.contractError) throw launch.contractError;
    },
  );
  try {
    await scenario(
      "loop.status_live",
      { requiresKey: true, spec: "§3.3" },
      async () => {
      expect(
        launchCompleted,
        "governed launch did not complete; status not requested",
      );
      const { status, json } = await request(
        "GET",
        `/v1/projects/${projectId}/status`,
        { authenticated: true },
      );
      expect(status === 200, `status returned ${status}`);
      // GET /status is an inventory read: no typed continuations
      // (envelope.schema.json#/$defs/inventoryReadSuccessEnvelope).
      assertSuccessEnvelope("status", json, "inventoryRead");
      expect(
        (json?.data?.services ?? []).some(
          (item) => item.name === service && item.status === "live",
        ),
        "canary service not live",
      );
    });
  } finally {
    // Cleanup is an independent scenario so a launch/status failure remains
    // visible even if cleanup also fails. A failed authority preflight keeps
    // this path non-mutating.
    await scenario(
      "loop.teardown",
      { requiresKey: true, spec: "§11.7 · §11.8" },
      async () => {
        expect(
          governedPreflightPassed,
          "governed authority preflight did not pass; refusing cleanup mutation",
        );
        for (const admission of [resetAdmission, launchAdmission]) {
          if (unsafeAdmissionPhases.has(admission.phase)) {
            throw new Error(cleanupRefusal(admission));
          }
        }
        if (launchAdmission.phase !== "settled") {
          if (resetAdmission.phase === "settled" && !scratchResetClean) {
            throw new Error(
              "pre-run reset settled without proving an empty project; refusing a second teardown with a different Idempotency-Key",
            );
          }
          return {
            cleanup: "not_needed",
            reason: "no launch task was accepted and settled",
          };
        }
        const cleanup = await dispatchAndReconcileTaskMutation(
          "teardown",
          cleanupAdmission,
          `/v1/projects/${projectId}/teardown`,
          {
            body: {
              dryRun: false,
              justification: "public conformance canary cleanup",
            },
            headers: { "idempotency-key": `${runId}-teardown` },
            authenticated: true,
          },
        );
        if (cleanup.contractError) throw cleanup.contractError;
        return { cleanup: "completed" };
      },
    );
  }

  const runnable = results.filter((result) => result.status !== "not_run");
  const passed = runnable.filter((result) => result.status === "pass");
  return {
    baseUrl,
    ranAt: new Date().toISOString(),
    governedLoopIncluded: Boolean(agentKey && projectId),
    scenarios: results,
    completion: {
      passed: passed.length,
      ran: runnable.length,
      rate: runnable.length ? passed.length / runnable.length : 0,
    },
  };
}
