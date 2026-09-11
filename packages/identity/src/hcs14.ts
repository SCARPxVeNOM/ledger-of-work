import { base58Encode } from "./base58.js";

/**
 * HCS-14 — a universal agent id.
 *
 * ── What it is for ──────────────────────────────────────────────────────────────
 * Every agent protocol has its own way of naming an agent: an A2A card lives at a URL,
 * an MCP server is a command, a Hedera account is `0.0.x`. None of them mean anything to
 * the others, so an agent that finds this service through one channel cannot tell it is
 * the same service it already knows from another.
 *
 * HCS-14 fixes that by deriving the name from what the agent *is* rather than from where
 * it was found. Two parties who have never spoken compute the same identifier for the
 * same agent, with no registry to agree on and nobody to ask.
 *
 * ── The part that is easy to get wrong ──────────────────────────────────────────
 * The hash covers exactly six fields, and deliberately excludes endpoints, topic ids and
 * anything else about *how to reach* the agent. That is the whole point: moving hosts,
 * changing domains or adding a second transport must not change who you are. Include an
 * endpoint in the hash and the identifier becomes an address, which is the problem it
 * exists to solve.
 *
 * Spec: https://hol.org/docs/standards/hcs-14/
 */

/** The six fields the identifier is derived from. Nothing else is hashed. */
export interface AgentIdentityInput {
  /** Registry that issued the agent's native id, lowercased. */
  registry: string;
  name: string;
  version: string;
  /** The agent's native protocol, lowercased — `a2a`, `mcp`, `hcs-10`. */
  protocol: string;
  /** The id in that protocol's own terms, e.g. `hedera:testnet:0.0.x`. */
  nativeId: string;
  /** Numeric skill tags. Sorted before hashing so ordering cannot change the id. */
  skills: number[];
}

/**
 * Canonical form of the six fields: keys sorted, registry and protocol lowercased,
 * strings trimmed, skills sorted numerically.
 *
 * Exported because it is the thing to look at when two implementations disagree about an
 * identifier. The hash is opaque; this is not.
 */
export function canonicalIdentity(input: AgentIdentityInput): string {
  const normalised = {
    name: input.name.trim(),
    nativeId: input.nativeId.trim(),
    protocol: input.protocol.trim().toLowerCase(),
    registry: input.registry.trim().toLowerCase(),
    skills: [...input.skills].sort((a, b) => a - b),
    version: input.version.trim(),
  };
  // Object literal above is already in alphabetical key order, and JSON.stringify
  // preserves insertion order for string keys — but say it explicitly rather than rely
  // on that, because the ordering is load-bearing for the hash.
  return JSON.stringify(normalised, Object.keys(normalised).sort());
}

/**
 * The AID: base58 of the SHA-384 over the canonical fields.
 *
 * SHA-384 rather than SHA-256 is the spec's choice, for margin under quantum search.
 * Taking the digest is the one step that needs a platform primitive, so it is passed in
 * — the same split as `@low/protocol`, and for the same reason: this module stays
 * synchronous and runs in a browser.
 */
export function agentIdFromDigest(digest: Uint8Array): string {
  if (digest.length !== 48) {
    throw new Error(`HCS-14 expects a 48-byte SHA-384 digest, got ${digest.length}`);
  }
  return base58Encode(digest);
}

export interface UaidParams {
  /** Disambiguates two agents that hash identically. `0` unless you have a collision. */
  uid?: string;
  registry?: string;
  proto?: string;
  nativeId?: string;
  domain?: string;
}

/**
 * Assemble the `uaid:aid:<hash>;k=v;…` string.
 *
 * Parameter order is fixed by the spec — uid, registry, proto, nativeId, domain — because
 * the whole string is compared verbatim by anyone resolving it. Sorting these differently
 * produces an identifier that is correct in spirit and unequal in practice.
 */
export function formatUaid(hash: string, params: UaidParams = {}): string {
  const ordered: Array<[string, string | undefined]> = [
    ["uid", params.uid ?? "0"],
    ["registry", params.registry],
    ["proto", params.proto],
    ["nativeId", params.nativeId],
    ["domain", params.domain],
  ];
  const tail = ordered
    .filter((pair): pair is [string, string] => Boolean(pair[1]))
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  return `uaid:aid:${hash}${tail ? `;${tail}` : ""}`;
}

/** Split a `uaid:aid:` string back into its hash and parameters. Null if it is not one. */
export function parseUaid(
  uaid: string,
): { method: string; id: string; params: Record<string, string> } | null {
  const match = /^uaid:([a-z0-9]+):([^;]+)(;.*)?$/.exec(uaid.trim());
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const part of (match[3] ?? "").split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { method: match[1] as string, id: match[2] as string, params };
}
