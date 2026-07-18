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
  ["POST", "/v1/scratch-signup"],
  ["POST", "/v1/scratch-signup/poll"],
  ["POST", "/v1/waitlist"],
  ["POST", "/v1/quotes"],
  ["POST", "/v1/projects"],
  ["POST", "/v1/domain-connections"],
  ["POST", "/v1/domain-connections/{id}/check"],
  ["POST", "/v1/domains/{domain}/dns"],
  ["DELETE", "/v1/domains/{domain}/dns/{recordId}"],
  ["POST", "/v1/projects/{id}/assets"],
  ["POST", "/v1/projects/{id}/launch"],
  ["POST", "/v1/projects/{id}/teardown"],
  ["POST", "/v1/domains/{domain}/apply-registrant"],
  ["POST", "/v1/projects/{id}/budget-request"],
  ["POST", "/v1/org/budget-request"],
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

const MUTATING_ENVELOPE_REF = "#/components/schemas/MutatingSuccessEnvelope";

function assertOpenApiContract(condition, message) {
  if (!condition) throw new Error(message);
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
        Array.isArray(schema?.allOf) &&
          schema.allOf.some((part) => part?.$ref === MUTATING_ENVELOPE_REF),
        `${method} ${path} ${status} does not use MutatingSuccessEnvelope`,
      );
      assertOpenApiContract(
        schema.allOf.some((part) => part?.properties?.data),
        `${method} ${path} ${status} omitted its operation-specific data schema`,
      );
    }
  }

  const receipt = schemas.Receipt;
  const resource = receipt?.properties?.resources?.items;
  assertOpenApiContract(
    includesEvery(receipt?.required, [
      "action",
      "oneTimeUsd",
      "monthlyDeltaUsd",
      "resources",
    ]) &&
      receipt?.properties?.action?.type === "string" &&
      receipt.properties.action.minLength >= 1 &&
      receipt?.properties?.oneTimeUsd?.type === "number" &&
      receipt.properties.oneTimeUsd.minimum === 0 &&
      receipt?.properties?.monthlyDeltaUsd?.type === "number" &&
      receipt?.properties?.resources?.type === "array" &&
      resource?.type === "object" &&
      includesEvery(resource.required, ["kind", "provider", "externalId"]) &&
      ["kind", "provider", "externalId"].every(
        (field) =>
          resource?.properties?.[field]?.type === "string" &&
          resource.properties[field].minLength >= 1,
      ),
    "Receipt does not require complete action, cost, and resource evidence",
  );
  const undoBranches = schemas.Undo?.oneOf;
  assertOpenApiContract(
    Array.isArray(undoBranches) &&
      undoBranches.length === 2 &&
      undoBranches.every(
        (branch) =>
          branch?.type === "object" &&
          includesEvery(branch.required, ["command", "irreversible"]),
      ) &&
      undoBranches.some(
        (branch) =>
          branch?.properties?.command?.type === "string" &&
          branch?.properties?.command?.minLength >= 1 &&
          branch?.properties?.irreversible?.const === false,
      ) &&
      undoBranches.some(
        (branch) =>
          branch?.properties?.command?.type === "null" &&
          branch?.properties?.irreversible?.const === true,
      ),
    "Undo must explicitly choose a concrete reversible command or an irreversible marker",
  );
  assertOpenApiContract(
    includesEvery(schemas.MutatingSuccessData?.required, [
      "receipt",
      "undo",
      "budgetRemainingUsd",
    ]) &&
      !Object.hasOwn(
        schemas.MutatingSuccessData?.properties ?? {},
        "nextActions",
      ) &&
      ["nextActions", "replayed"].every((field) =>
        schemas.MutatingSuccessData?.not?.anyOf?.some(
          (branch) =>
            Array.isArray(branch?.required) && branch.required.includes(field),
        ),
      ) &&
      schemas.MutatingSuccessData?.properties?.budgetRemainingUsd?.type ===
        "number" &&
      schemas.MutatingSuccessData.properties.budgetRemainingUsd.minimum === 0,
    "MutatingSuccessData must contain only data-level evidence, not nextActions or replay transport metadata",
  );
  const actionableContinuation = schemas.ActionableSuccessEnvelope?.allOf?.find(
    (part) => part?.properties?.nextActions,
  )?.properties?.nextActions;
  assertOpenApiContract(
    actionableContinuation?.type === "array" &&
      actionableContinuation?.minItems >= 1 &&
      actionableContinuation?.items?.type === "string" &&
      actionableContinuation.items.minLength >= 1,
    "ActionableSuccessEnvelope does not require a non-empty nextActions array",
  );
  const mutatingEnvelopeBranch = schemas.MutatingSuccessEnvelope?.allOf?.find(
    (part) =>
      part?.properties?.data?.$ref ===
      "#/components/schemas/MutatingSuccessData",
  );
  assertOpenApiContract(
    schemas.MutatingSuccessEnvelope?.allOf?.some(
      (part) => part?.$ref === "#/components/schemas/ActionableSuccessEnvelope",
    ) &&
      mutatingEnvelopeBranch?.type === "object" &&
      hasExactValues(mutatingEnvelopeBranch.required, [
        "data",
        "nextActions",
      ]) &&
      hasExactKeys(mutatingEnvelopeBranch.properties, [
        "data",
        "nextActions",
        "replayed",
      ]) &&
      mutatingEnvelopeBranch.properties.nextActions?.type === "array" &&
      mutatingEnvelopeBranch.properties.nextActions.minItems >= 1 &&
      mutatingEnvelopeBranch.properties.nextActions.items?.type === "string" &&
      mutatingEnvelopeBranch.properties.nextActions.items.minLength >= 1 &&
      mutatingEnvelopeBranch.properties.replayed?.type === "boolean" &&
      mutatingEnvelopeBranch.additionalProperties === false,
    "MutatingSuccessEnvelope does not strictly combine actionable continuation, replay metadata, and mutation evidence",
  );
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

export async function runPublicEvals(options = {}) {
  const baseUrl = canonicalBaseUrl(options.baseUrl);
  const agentKey = options.agentKey;
  const projectId = options.projectId;
  const fetchImpl = options.fetchImpl ?? fetch;
  const launchTimeoutMs = options.launchTimeoutMs ?? 240_000;
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
      expect(catalog.schemaVersion === "1", "MCP tool catalog schema changed");
      expect(
        catalog.mcp === `${baseUrl}/mcp`,
        "MCP catalog URL was not canonical",
      );
      expect(
        manifest.toolCatalog === `${baseUrl}/.well-known/mcp-tools.json`,
        "MCP manifest did not link the canonical tool catalog",
      );
      expect(Array.isArray(catalog.tools), "MCP tool catalog omitted tools");
      expect(catalog.tools.length > 0, "MCP tool catalog was empty");
      expect(
        manifest.toolCount === catalog.tools.length,
        "MCP manifest and catalog tool counts drifted",
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
          typeof tool.name === "string" && tool.name.length > 0,
          "MCP catalog tool name was invalid",
        );
        expect(
          typeof tool.title === "string" && tool.title.length > 0,
          `${tool.name}: catalog title was invalid`,
        );
        expect(
          typeof tool.description === "string" && tool.description.length > 0,
          `${tool.name}: catalog description was invalid`,
        );
        expect(
          ["anonymous", "optional", "required"].includes(tool.auth),
          `${tool.name}: catalog auth was invalid`,
        );
        expect(
          Array.isArray(tool.scopes) &&
            tool.scopes.every((scope) => typeof scope === "string"),
          `${tool.name}: catalog scopes were invalid`,
        );
        expect(
          ["read", "reserve", "credential", "write", "delete"].includes(
            tool.effect,
          ),
          `${tool.name}: catalog effect was invalid`,
        );
        expect(
          ["none", "client-key", "state-machine"].includes(tool.idempotency),
          `${tool.name}: catalog idempotency was invalid`,
        );
        expect(
          ["none", "returns_handle", "polls_handle"].includes(tool.taskMode),
          `${tool.name}: catalog task mode was invalid`,
        );
        expect(
          typeof tool.hasOutputSchema === "boolean",
          `${tool.name}: catalog output-schema flag was invalid`,
        );
        expect(
          isObject(tool.annotations) &&
            isDeepStrictEqual(
              Object.keys(tool.annotations).sort(),
              requiredAnnotationKeys,
            ) &&
            Object.values(tool.annotations).every(
              (annotation) => typeof annotation === "boolean",
            ),
          `${tool.name}: catalog annotations were invalid`,
        );
        expect(
          isObject(tool.lifecycle) &&
            ["active", "unavailable", "deprecated"].includes(
              tool.lifecycle.status,
            ),
          `${tool.name}: catalog lifecycle was invalid`,
        );
        names.push(tool.name);
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

  async function pollTask(taskId) {
    const deadline = Date.now() + launchTimeoutMs;
    for (;;) {
      const { status, json } = await request("GET", `/v1/tasks/${taskId}`, {
        authenticated: true,
      });
      expect(status === 200, `task poll returned ${status}`);
      assertSuccessEnvelope("task poll", json);
      const task = json?.data ?? json;
      if (task.status === "completed") return task;
      if (task.status === "failed")
        throw new Error(
          `task failed: ${JSON.stringify(task.error ?? task).slice(0, 300)}`,
        );
      if (task.status === "input_required")
        throw new Error("governed canary hit an unexpected approval gate");
      if (Date.now() > deadline)
        throw new Error(
          `task ${taskId} still ${task.status} after ${launchTimeoutMs}ms`,
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

    const taskId = response.json?.data?.taskId ?? response.json?.data?.id;
    if (typeof taskId !== "string" || taskId.length === 0) {
      admission.phase = "ambiguous";
      admission.reason = `accepted HTTP ${response.status} response omitted taskId`;
      throw new Error(
        `${label} returned ${response.status} without a taskId; admission is ambiguous`,
      );
    }

    admission.phase = "accepted";
    admission.taskId = taskId;
    let contractError;
    try {
      assertSuccessEnvelope(label, response.json, "mutation");
    } catch (error) {
      contractError = error;
    }

    try {
      await pollTask(taskId);
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
          catalog.tools.map((tool) => [tool.name, tool]),
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
            tool.description === contract.description,
            `${name}: description drifted`,
          );
          expect(
            isDeepStrictEqual(tool.annotations, contract.annotations),
            `${name}: annotations drifted`,
          );
          expect(
            isObject(tool.inputSchema),
            `${name}: inputSchema was missing`,
          );
          expect(
            (tool.outputSchema !== undefined) === contract.hasOutputSchema &&
              (!contract.hasOutputSchema || isObject(tool.outputSchema)),
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
        expect(Array.isArray(payload.nextActions), "help omitted nextActions");
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
          isObject(payload.resolution) && payload.resolution.type === "retry",
          "invalid estimate omitted its retry resolution",
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

      const { status, json } = await request("POST", "/v1/quotes", {
        body: { projectId, domain: scratchDomain, service },
        headers: { "idempotency-key": `${runId}-quote` },
        authenticated: true,
      });
      expect(status === 200, `quote returned ${status}`);
      assertSuccessEnvelope("quote", json, "mutation");
      expect(
        json?.data?.verdict === "ALLOW",
        `quote verdict ${json?.data?.verdict}`,
      );
      governedReady = true;
      return { scratchReset: "completed" };
    },
  );
  await scenario(
    "loop.launch",
    { requiresKey: true, spec: "§11.1 · §11.8" },
    async () => {
      expect(
        governedReady,
        "governed scratch reset and quote did not complete",
      );
      const launch = await dispatchAndReconcileTaskMutation(
        "launch",
        launchAdmission,
        `/v1/projects/${projectId}/launch`,
        {
          body: {
            domain: scratchDomain,
            template: "static-site",
            service,
            justification:
              "public conformance canary — isolated scratch service",
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
    await scenario("loop.status_live", { requiresKey: true }, async () => {
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
      assertSuccessEnvelope("status", json, "actionable");
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
