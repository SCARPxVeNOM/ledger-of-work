import { createHash } from "node:crypto";

/**
 * Canonical JSON encoding, RFC 8785 in spirit: object keys sorted, no insignificant
 * whitespace, `undefined` members dropped exactly as `JSON.stringify` drops them.
 *
 * Why this exists: `JSON.stringify` serialises keys in insertion order, so two encoders
 * that agree on the *value* can disagree on the *bytes* and therefore on the hash. A
 * verifier run by someone who did not build the object must be able to reproduce our
 * bytes exactly, or every check downstream is a coin flip.
 *
 * Deliberately narrow: no support for BigInt, Date, Map, Set, or class instances. Those
 * have no single obvious JSON encoding, and silently picking one would be the same
 * category of bug this function exists to prevent. Convert them at the edge.
 */
export function canonical(value: unknown): string {
  if (value === undefined) {
    throw new TypeError("canonical: undefined is not encodable");
  }
  if (typeof value === "bigint") {
    throw new TypeError("canonical: BigInt is not encodable — pass a decimal string");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`canonical: ${String(value)} is not encodable`);
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) {
    // JSON.stringify renders array holes and undefined elements as null; match that.
    return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

/** SHA-256 of the canonical encoding, prefixed with its algorithm. */
export function hashCanonical(value: unknown): string {
  return sha256(Buffer.from(canonical(value), "utf8"));
}

/** SHA-256 of raw bytes, prefixed with its algorithm (`sha256:<hex>`). */
export function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Byte length of the canonical encoding — used to keep receipts inside one HCS chunk. */
export function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(canonical(value), "utf8");
}
