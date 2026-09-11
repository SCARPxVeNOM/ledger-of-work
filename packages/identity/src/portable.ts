/**
 * The half of identity that runs anywhere.
 *
 * Excludes `index.ts`, which reaches for `node:crypto` to take the SHA-384. Same split
 * as `@low/protocol/portable`, and for the same reason: a browser supplies its own
 * digest, while the *encoding* the digest is taken over lives on this side of the line,
 * so the two runtimes cannot compute different identifiers for the same agent.
 */
export { base58Encode, base58Decode } from "./base58.js";
export {
  agentIdFromDigest,
  canonicalIdentity,
  formatUaid,
  parseUaid,
  type AgentIdentityInput,
  type UaidParams,
} from "./hcs14.js";
export { buildAgentCard, SKILL_TAGS, type CardCapability, type CardInput } from "./a2a.js";
