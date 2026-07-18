import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const DEFINITION_NAMES = [
  "successEnvelope",
  "actionableSuccessEnvelope",
  "mutatingSuccessData",
  "mutatingSuccessEnvelope",
  "nextActions",
  "actionableNextActions",
  "errorEnvelope",
];

/**
 * Load and compile the schema shipped inside this package. Callers use the
 * named definitions for operation-specific grading rather than weakening the
 * contract to the schema's generic success/error union.
 */
export async function loadEnvelopeContract() {
  const sourceUrl = new URL("../spec/envelope.schema.json", import.meta.url);
  const text = await readFile(sourceUrl, "utf8");
  const schema = JSON.parse(text);
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  const validators = {
    envelope: ajv.compile(schema),
  };
  for (const name of DEFINITION_NAMES) {
    const definition = schema.$defs?.[name];
    if (
      !definition ||
      typeof definition !== "object" ||
      Array.isArray(definition)
    ) {
      throw new Error(`bundled schema is missing $defs.${name}`);
    }
    validators[name] = ajv.compile({
      ...definition,
      $defs: schema.$defs,
    });
  }

  return {
    source: "@sproutpad/conformance/spec/envelope.schema.json",
    digest: createHash("sha256").update(text).digest("hex"),
    assert(name, value, label = name) {
      const validator = validators[name];
      if (typeof validator !== "function") {
        throw new Error(`unknown bundled schema definition: ${name}`);
      }
      if (!validator(value)) {
        throw new Error(
          `${label} schema violation: ${ajv.errorsText(validator.errors)}`,
        );
      }
    },
  };
}
