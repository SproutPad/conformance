import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonDigest,
} from "../lib/canonical.mjs";

describe("canonical JSON digest parity", () => {
  it("sorts recursively and follows ECMAScript number serialization", () => {
    const left = { z: -0, a: { y: 1e30, x: "\u20ac" }, list: [true, null] };
    const right = { list: [true, null], a: { x: "\u20ac", y: 1e30 }, z: 0 };
    expect(canonicalJson(left)).toBe(
      '{"a":{"x":"€","y":1e+30},"list":[true,null],"z":0}',
    );
    expect(canonicalJsonDigest(left)).toBe(canonicalJsonDigest(right));
  });

  it("orders object keys by UTF-16 code units", () => {
    const value = { z: 1, A: 2, a: 3 };
    expect(canonicalJson(value)).toBe('{"A":2,"a":3,"z":1}');
  });

  it("rejects values JSON would silently erase or coerce", () => {
    expect(() => canonicalJson({ bad: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson([, 1])).toThrow(/hole/);
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalJson(new Date())).toThrow(/plain object/);
  });

  it("rejects unpaired UTF-16 surrogates in values and property names", () => {
    expect(() => canonicalJson({ value: "\ud800" })).toThrow(
      /unpaired UTF-16 surrogate/,
    );
    expect(() => canonicalJson({ value: "\udfff" })).toThrow(
      /unpaired UTF-16 surrogate/,
    );
    expect(() => canonicalJson({ ["bad\ud800"]: true })).toThrow(
      /unpaired UTF-16 surrogate/,
    );
    expect(canonicalJson({ emoji: "\ud83d\ude80" })).toBe('{"emoji":"🚀"}');
  });
});
