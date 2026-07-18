import { createHash, timingSafeEqual } from "node:crypto";

/**
 * @typedef {null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson }} CanonicalJson
 */

/**
 * @typedef {{ alg: "ES256"; kid: string; jws: string }} CanonicalSignature
 */

/**
 * @param {string} value
 * @param {string} path
 */
function assertUnicodeScalarString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(
          `RFC 8785 string at ${path} contains an unpaired UTF-16 surrogate`,
        );
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(
        `RFC 8785 string at ${path} contains an unpaired UTF-16 surrogate`,
      );
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function canonicalize(value, path) {
  if (value === null) return "null";
  if (typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`RFC 8785 value at ${path} must be finite`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || value[index] === undefined) {
        throw new TypeError(
          `RFC 8785 array at ${path} contains an unsupported hole/undefined value`,
        );
      }
      items.push(canonicalize(value[index], `${path}[${index}]`));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`RFC 8785 value at ${path} must be a plain object`);
    }
    const object = /** @type {Record<string, unknown>} */ (value);
    const fields = [];
    for (const key of Object.keys(object).sort()) {
      assertUnicodeScalarString(key, `${path} property name`);
      if (object[key] === undefined) {
        throw new TypeError(
          `RFC 8785 object at ${path} contains unsupported undefined property ${key}`,
        );
      }
      fields.push(
        `${JSON.stringify(key)}:${canonicalize(object[key], `${path}.${key}`)}`,
      );
    }
    return `{${fields.join(",")}}`;
  }
  throw new TypeError(
    `RFC 8785 value at ${path} has unsupported type ${typeof value}`,
  );
}

/** RFC 8785 JSON Canonicalization Scheme bytes (UTF-8). */
export function canonicalJson(value) {
  return canonicalize(value, "$");
}

/** @param {CanonicalJson} value */
export function canonicalJsonBytes(value) {
  return new TextEncoder().encode(canonicalJson(value));
}

/** @param {CanonicalJson} value */
export function canonicalJsonDigest(value) {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

/** @param {string} value */
function b64urlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/**
 * Verify both the ES256 signature and that the signed payload is the exact
 * RFC 8785 representation of the supplied value.
 *
 * @param {CanonicalJson} value
 * @param {CanonicalSignature} signature
 * @param {{ keys: Array<Record<string, unknown>> }} jwks
 * @param {{ typ: string }} opts
 */
export async function verifyCanonicalJson(value, signature, jwks, opts) {
  if (signature.alg !== "ES256" || !signature.kid || !signature.jws) {
    return false;
  }
  try {
    const parts = signature.jws.split(".");
    if (parts.length !== 3) return false;
    const header = JSON.parse(
      new TextDecoder().decode(b64urlDecode(parts[0])),
    );
    if (
      header.alg !== "ES256" ||
      header.kid !== signature.kid ||
      header.typ !== opts.typ
    ) {
      return false;
    }
    const signedPayload = new TextDecoder().decode(b64urlDecode(parts[1]));
    const expected = canonicalJson(value);
    const expectedBytes = Buffer.from(canonicalJsonBytes(value));
    const actualBytes = Buffer.from(signedPayload, "utf8");
    if (
      signedPayload !== expected ||
      expectedBytes.length !== actualBytes.length ||
      !timingSafeEqual(expectedBytes, actualBytes)
    ) {
      return false;
    }
    const matchingKeys = jwks.keys.filter((key) => key.kid === signature.kid);
    if (matchingKeys.length !== 1) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      matchingKeys[0],
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}
