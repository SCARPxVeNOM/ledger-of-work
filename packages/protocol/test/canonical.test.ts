import { describe, expect, it } from "vitest";
import { canonical, canonicalByteLength } from "../src/canonical.js";
import { hashCanonical } from "../src/hash.js";

describe("canonical", () => {
  it("is stable under key insertion order", () => {
    const a = { b: 1, a: [3, { z: 1, y: 2 }], c: "x" };
    const b = { c: "x", a: [3, { y: 2, z: 1 }], b: 1 };
    expect(canonical(a)).toBe(canonical(b));
    expect(canonical(a)).toBe('{"a":[3,{"y":2,"z":1}],"b":1,"c":"x"}');
  });

  it("produces parseable JSON", () => {
    const value = { n: null, s: "ok", nested: { deep: [1, 2, { k: true }] } };
    expect(JSON.parse(canonical(value))).toEqual(value);
  });

  it("drops undefined members exactly as JSON.stringify does", () => {
    expect(canonical({ u: undefined, n: null })).toBe('{"n":null}');
    expect(JSON.parse(canonical({ u: undefined, keep: 1 }))).toEqual({ keep: 1 });
  });

  it("renders undefined array elements as null, matching JSON.stringify", () => {
    expect(canonical([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("preserves order within arrays — arrays are sequences, not sets", () => {
    expect(canonical([3, 1, 2])).toBe("[3,1,2]");
    expect(canonical([1, 2, 3])).not.toBe(canonical([3, 2, 1]));
  });

  it("escapes keys and string values", () => {
    expect(canonical({ 'a"b': 'c\nd' })).toBe('{"a\\"b":"c\\nd"}');
  });

  it("refuses values with no single obvious encoding", () => {
    expect(() => canonical(undefined)).toThrow(/undefined/);
    expect(() => canonical(10n)).toThrow(/BigInt/);
    expect(() => canonical(Number.NaN)).toThrow(/NaN/);
    expect(() => canonical(Number.POSITIVE_INFINITY)).toThrow(/Infinity/);
  });

  it("hashes equal values to equal digests regardless of key order", () => {
    expect(hashCanonical({ x: 1, y: 2 })).toBe(hashCanonical({ y: 2, x: 1 }));
  });

  it("hashes differing values to differing digests", () => {
    expect(hashCanonical({ x: 1 })).not.toBe(hashCanonical({ x: 2 }));
  });

  it("counts UTF-8 bytes, not code units", () => {
    // A four-byte emoji must not be counted as two.
    expect(canonicalByteLength("😀")).toBe(Buffer.byteLength('"😀"', "utf8"));
  });
});
