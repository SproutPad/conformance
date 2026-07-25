import { PUBLIC_MUTATION_OPERATIONS } from "../../lib/public-evals.mjs";

/** Minimal but structurally complete OpenAPI fixture for discovery probes. */
export function validMutationOpenApi() {
  const paths = {};
  for (const [method, path] of PUBLIC_MUTATION_OPERATIONS) {
    paths[path] ??= {};
    paths[path][method.toLowerCase()] = {
      "x-sproutpad-operation-class": "mutation",
      responses: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["data"],
                properties: {
                  data: {
                    type: "object",
                    required: ["receipt", "undo", "budgetRemainingUsd", "actions"],
                    properties: {
                      receipt: { $ref: "#/components/schemas/Receipt" },
                      undo: { $ref: "#/components/schemas/Undo" },
                      budgetRemainingUsd: { type: "number", minimum: 0 },
                      actions: {
                        type: "array",
                        minItems: 1,
                        items: { $ref: "#/components/schemas/AgentAction" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    paths,
    components: {
      schemas: {
        AgentAction: {
          oneOf: [
            { type: "object", required: ["kind", "tool", "arguments"] },
            { type: "object", required: ["kind", "url", "purpose", "requiresHuman"] },
            { type: "object", required: ["kind", "reason"] },
            {
              type: "object",
              required: ["kind", "purpose", "instruction", "requiresHuman"],
            },
          ],
        },
        Receipt: {
          type: "object",
          required: ["action", "oneTimeUsd", "monthlyDeltaUsd", "resources"],
          properties: {
            action: { type: "string", minLength: 1 },
            oneTimeUsd: { type: "number", minimum: 0 },
            monthlyDeltaUsd: { type: "number" },
            resources: {
              type: "array",
              items: {
                type: "object",
                required: ["kind", "provider", "externalId"],
                properties: {
                  kind: { type: "string", minLength: 1 },
                  provider: { type: "string", minLength: 1 },
                  externalId: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        Undo: {
          oneOf: [
            {
              type: "object",
              required: ["command", "irreversible"],
              properties: {
                command: { type: "string", minLength: 1 },
                irreversible: { type: "boolean", const: false },
              },
            },
            {
              type: "object",
              required: ["command", "irreversible"],
              properties: {
                command: { type: "null" },
                irreversible: { type: "boolean", const: true },
              },
            },
          ],
        },
      },
    },
  };
}
