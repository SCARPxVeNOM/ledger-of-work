import { createHash } from "node:crypto";
import { agentIdFromDigest, canonicalIdentity, formatUaid, type AgentIdentityInput, type UaidParams } from "./hcs14.js";

export * from "./portable.js";

/**
 * Derive the HCS-14 identifier for an agent, digest included.
 *
 * The one-call version for Node. Anything that cannot reach `node:crypto` should use
 * `canonicalIdentity` + its own SHA-384 + `agentIdFromDigest`, which is the same
 * computation with the platform-specific step handed back to the caller.
 */
export function agentId(input: AgentIdentityInput): string {
  const digest = createHash("sha384").update(canonicalIdentity(input), "utf8").digest();
  return agentIdFromDigest(new Uint8Array(digest));
}

/** The full `uaid:aid:…` string for an agent, parameters and all. */
export function agentUaid(input: AgentIdentityInput, params: UaidParams = {}): string {
  return formatUaid(agentId(input), {
    registry: input.registry,
    proto: input.protocol,
    nativeId: input.nativeId,
    ...params,
  });
}
