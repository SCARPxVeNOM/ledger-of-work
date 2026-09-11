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
 * It is a *discovery* document. It tells another agent what is here, what each thing
 * costs, and how to pay for it — and the payment is x402, not an A2A task. This is not a
 * full A2A server: there is no JSON-RPC `message/send` endpoint behind it, and the card
 * says so in its interfaces rather than implying one.
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
