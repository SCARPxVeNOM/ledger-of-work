import { createHash } from "node:crypto";
import { canonical } from "./canonical.js";

/**
 * SHA-256 helpers, kept apart from `canonical` on purpose.
 *
 * Canonicalisation is pure string work and runs anywhere; hashing is the only part of
 * the trust core that needs a platform primitive. Separating them lets the verifier be
 * bundled for a browser — which reads Web Crypto instead — without either side
 * reimplementing the encoding the hash is taken over. Two encoders would eventually
 * disagree, and that disagreement is precisely what canonicalisation exists to prevent.
 */

/** SHA-256 of raw bytes, prefixed with its algorithm (`sha256:<hex>`). */
export function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** SHA-256 of the canonical encoding of a value. */
export function hashCanonical(value: unknown): string {
  return sha256(Buffer.from(canonical(value), "utf8"));
}
