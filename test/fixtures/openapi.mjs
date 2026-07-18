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
                allOf: [
                  {
                    $ref: "#/components/schemas/MutatingSuccessEnvelope",
                  },
                  {
                    type: "object",
                    properties: { data: { type: "object" } },
                  },
                ],
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
        ResponseEnvelope: {
          type: "object",
          required: ["data"],
          properties: { data: {} },
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
        MutatingSuccessData: {
          type: "object",
          required: ["receipt", "undo", "budgetRemainingUsd"],
          properties: {
            receipt: { $ref: "#/components/schemas/Receipt" },
            undo: { $ref: "#/components/schemas/Undo" },
            budgetRemainingUsd: { type: "number", minimum: 0 },
          },
          not: {
            anyOf: [{ required: ["nextActions"] }, { required: ["replayed"] }],
          },
        },
        ActionableSuccessEnvelope: {
          allOf: [
            { $ref: "#/components/schemas/ResponseEnvelope" },
            {
              type: "object",
              required: ["data", "nextActions"],
              properties: {
                nextActions: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
              },
            },
          ],
        },
        MutatingSuccessEnvelope: {
          allOf: [
            { $ref: "#/components/schemas/ActionableSuccessEnvelope" },
            {
              type: "object",
              required: ["data", "nextActions"],
              properties: {
                data: { $ref: "#/components/schemas/MutatingSuccessData" },
                nextActions: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
                replayed: { type: "boolean" },
              },
              additionalProperties: false,
            },
          ],
        },
      },
    },
  };
}
