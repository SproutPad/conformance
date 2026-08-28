/**
 * Explicit operation-level evidence emitted by the public conformance runner.
 *
 * This is intentionally keyed by canonical operation ID and scenario ID.
 * Source-code strings, HTTP path literals, and request fixtures are not
 * coverage authority.
 */
export const PUBLIC_CONFORMANCE_SCENARIO_IDS = Object.freeze({
  mcpHelp: "mcp.help_result_contract",
  mcpEstimateError: "mcp.semantic_error_contract",
  searchDomains: "anon.search_domains",
  unauthenticatedQuote: "governance.structured_error_unauthenticated",
  governedSetupAndQuote: "loop.quote",
  governedLaunch: "loop.launch",
  governedStatus: "loop.status_live",
  governedTeardown: "loop.teardown",
});

export const PUBLIC_CONFORMANCE_OPERATION_PROBES = Object.freeze([
  {
    operationId: "estimate",
    scenarioIds: [PUBLIC_CONFORMANCE_SCENARIO_IDS.mcpEstimateError],
  },
  {
    operationId: "get_status",
    scenarioIds: [PUBLIC_CONFORMANCE_SCENARIO_IDS.governedStatus],
  },
  {
    operationId: "get_task",
    scenarioIds: [
      PUBLIC_CONFORMANCE_SCENARIO_IDS.governedSetupAndQuote,
      PUBLIC_CONFORMANCE_SCENARIO_IDS.governedLaunch,
      PUBLIC_CONFORMANCE_SCENARIO_IDS.governedTeardown,
    ],
  },
  {
    operationId: "help",
    scenarioIds: [PUBLIC_CONFORMANCE_SCENARIO_IDS.mcpHelp],
  },
  {
    operationId: "launch_service",
    scenarioIds: [PUBLIC_CONFORMANCE_SCENARIO_IDS.governedLaunch],
  },
  {
    operationId: "list_resources",
    scenarioIds: [PUBLIC_CONFORMANCE_SCENARIO_IDS.governedSetupAndQuote],
  },
  {
    operationId: "quote",
    scenarioIds: [
      PUBLIC_CONFORMANCE_SCENARIO_IDS.unauthenticatedQuote,
      PUBLIC_CONFORMANCE_SCENARIO_IDS.governedSetupAndQuote,
    ],
  },
  {
    operationId: "search_domains",
    scenarioIds: [PUBLIC_CONFORMANCE_SCENARIO_IDS.searchDomains],
  },
  {
    operationId: "teardown",
    scenarioIds: [
      PUBLIC_CONFORMANCE_SCENARIO_IDS.governedSetupAndQuote,
      PUBLIC_CONFORMANCE_SCENARIO_IDS.governedTeardown,
    ],
  },
  {
    operationId: "upload_assets",
    scenarioIds: [PUBLIC_CONFORMANCE_SCENARIO_IDS.governedSetupAndQuote],
  },
  {
    operationId: "whoami",
    scenarioIds: [PUBLIC_CONFORMANCE_SCENARIO_IDS.governedSetupAndQuote],
  },
]);

/**
 * Deliberate exclusions require a human-readable reason. Keep this empty until
 * a real exception is accepted; an unexplained gap must remain visible.
 */
export const PUBLIC_CONFORMANCE_OPERATION_EXCUSES = Object.freeze({});
