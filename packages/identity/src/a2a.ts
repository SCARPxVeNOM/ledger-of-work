/**
 * An A2A agent card, built from the capabilities this seller actually has.
 *
 * ── Why generate it ─────────────────────────────────────────────────────────────
 * A hand-written card is a second copy of the catalogue, and a second copy drifts. The
 * failure is quiet and specific: an agent discovers a skill on the card, asks for it, and
 * gets a 404 from a service that stopped offering it a month ago. Deriving the card from
 * the same specs the seller prices and executes from makes that impossible.
 *
 * ── What this card does and does not claim ──────────────────────────────────────
 * It is a *discovery* document, and it now points at a negotiation endpoint as well as a
 * payment one. `message/send` is answered at `/a2a`, in the hybrid shape A2A describes:
 * messages carry the back-and-forth that settles what the work should be, and the job
 * itself remains an x402 purchase rather than an A2A task, because the job already has a
 * lifecycle — quoted, paid, metered over SSE, receipted on chain.
 *
 * What is negotiable there is scope, not price. The price is a pure function of a price
 * book published in this very card, and the verifier checks that the two agree.
 *
 * Served at `/.well-known/agent-card.json`, the path A2A specifies (RFC 8615).
 */

export interface CardCapability {
  name: string;
  description: string;
  site: string;
  /** Cheapest possible price for this capability, in tinybars, as a string. */
  fromTinybar: string;
}

export interface CardInput {
  /** Absolute base URL this service answers on. */
  baseUrl: string;
  /** HCS-14 universal agent id. The stable name; the URL above is merely where it lives. */
  uaid: string;
  /** Hedera account that receives payment. */
  account: string;
  /** HCS topic carrying the receipts. */
  receiptsTopic: string;
  network: string;
  capabilities: CardCapability[];
  version: string;
}

/**
 * Skill tags, as HCS-14 numbers.
 *
 * The standard's registry is small and none of its entries mean "buys and sells work",
 * so these are the two that genuinely apply: data retrieval, and transaction handling.
 * Claiming more would make the identifier wrong rather than impressive.
 */
export const SKILL_TAGS = [0, 17];

export function buildAgentCard(input: CardInput): Record<string, unknown> {
  return {
    // A2A identifies agents by URL; HCS-14 identifies them by what they are. Both are
    // here so an agent arriving by either route can tell it is the same service.
    id: input.uaid,
    name: "Ledger of Work",
    description:
      "Sells completed multi-step web work, priced by the work actually performed, with a " +
      "tamper-evident receipt on Hedera Consensus Service for every job. Payment is x402; " +
      "no API key, no subscription, no prior relationship.",
    version: input.version,
    protocolVersion: "0.3.0",
    provider: { name: "Ledger of Work", url: input.baseUrl },
    url: input.baseUrl,

    interfaces: [
      {
        // The negotiation endpoint. Listed first because it is where an agent with a
        // budget should start: it can be told what its money buys before committing.
        type: "jsonrpc",
        url: `${input.baseUrl}/a2a`,
        description:
          "A2A message/send. Send a data part with {capability, params, budgetTinybar} to " +
          "open terms; the reply either accepts, counter-offers a smaller scope at the " +
          "same published rate, or refuses with the floor price. Reply {accept:true} with " +
          "the contextId to receive a run URL to pay with x402.",
      },
      {
        // x402 rather than an A2A task endpoint, stated plainly so a client does not
        // send `message/send` to something that will not answer it.
        type: "x402",
        url: `${input.baseUrl}/jobs`,
        description:
          "Quote at POST /jobs, then POST the returned run URL. The first call answers 402 " +
          "with payment requirements; repeat it with a PAYMENT-SIGNATURE header.",
      },
      {
        type: "http",
        url: `${input.baseUrl}/.well-known/x402`,
        description: "The full manifest: capabilities, published price books, payment assets.",
      },
    ],

    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },

    // Not an A2A field. An agent comparing sellers wants to know what can be moved before
    // it opens a conversation, and "scope, not price" is a short and checkable answer.
    "x-negotiation": {
      endpoint: `${input.baseUrl}/a2a`,
      method: "message/send",
      negotiable: ["scope", "asset"],
      fixed: ["rate"],
      note:
        "Prices follow the published price book and are checked by the verifier, so the " +
        "rate is not negotiable. A budget below the asking price is answered with a " +
        "smaller job at the same rate.",
    },

    skills: input.capabilities.map((c) => ({
      id: c.name,
      name: c.name,
      description: c.description,
      tags: ["x402", "hedera", "web-automation", new URL(c.site).hostname],
      // Not part of A2A, and deliberately included: an agent choosing between providers
      // needs a number before it commits to a quote round trip.
      pricing: { from: c.fromTinybar, unit: "tinybar", model: "metered-by-work" },
    })),

    securitySchemes: {
      x402: {
        type: "http",
        scheme: "x402",
        description: `Pay per job in HBAR or HTS on ${input.network}. Settled through the Blocky402 facilitator.`,
      },
    },
    security: [{ x402: [] }],

    // Everything below is ours rather than A2A's. An agent that does not know these keys
    // ignores them; one that does can check a receipt before trusting the next answer.
    "x-hedera": {
      network: input.network,
      account: input.account,
      receiptsTopic: input.receiptsTopic,
      receiptsExplorer: `https://hashscan.io/testnet/topic/${input.receiptsTopic}`,
      uaid: input.uaid,
    },
  };
}
