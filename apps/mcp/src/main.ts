import "dotenv/config";
import { createInterface } from "node:readline";
import { buildPayment, type PaymentRequirements } from "@low/buyer-cli";

/**
 * An MCP server that buys jobs on the caller's behalf.
 *
 * This is the discoverability half of the pitch made concrete: an agent that speaks MCP
 * discovers what is for sale by reading the seller's manifest at runtime, sees what each
 * unit of work costs, pays a 402 out of its own wallet, and gets back a result plus a
 * receipt locator anyone can verify. No API key, no account, no prior relationship with
 * the seller.
 *
 * Implemented against the JSON-RPC wire format directly rather than through an SDK: the
 * surface is three methods, and stdio framing is line-delimited JSON.
 */

const SELLER = process.env.SELLER_URL ?? "http://localhost:8402";

interface Manifest {
  capabilities: Array<{
    name: string;
    site: string;
    description: string;
    priceBook: Record<string, string>;
    limits: Record<string, number>;
  }>;
  receipts: { topicId: string; submitter: string; explorer: string };
  payment: { network: string; asset: string; payTo: string; feePayer: string };
}

let manifest: Manifest | null = null;

async function getManifest(): Promise<Manifest> {
  if (manifest) return manifest;
  const res = await fetch(`${SELLER}/`);
  if (!res.ok) throw new Error(`seller manifest unavailable (${res.status})`);
  manifest = (await res.json()) as Manifest;
  return manifest;
}

/** Quote without paying. Free, and lets an agent decide whether the price is worth it. */
async function quote(capability: string, params: unknown) {
  const res = await fetch(`${SELLER}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`quote failed: ${JSON.stringify(body)}`);
  return body as { jobId: string; run: string; price: { amount: string }; plan: unknown };
}

/** Quote, pay, run. Spends real HBAR from the configured buyer account. */
async function buy(capability: string, params: unknown, maxTinybar?: string) {
  const q = await quote(capability, params);

  // Spend control: an autonomous agent should refuse a price it did not expect.
  if (maxTinybar && BigInt(q.price.amount) > BigInt(maxTinybar)) {
    throw new Error(
      `quote ${q.price.amount} tinybar exceeds your limit of ${maxTinybar}; not paying`,
    );
  }

  const challenge = await fetch(q.run, { method: "POST" });
  if (challenge.status !== 402) throw new Error(`expected 402, got ${challenge.status}`);
  const { accepts } = (await challenge.json()) as { accepts: PaymentRequirements[] };

  const header = await buildPayment(accepts[0] as PaymentRequirements, {
    accountId: env("BUYER_ACCOUNT_ID"),
    privateKey: env("BUYER_PRIVATE_KEY"),
    network: process.env.HEDERA_NETWORK ?? "testnet",
  });

  const res = await fetch(q.run, { method: "POST", headers: { "payment-signature": header } });
  const body = await res.json();
  if (!res.ok) throw new Error(`job failed: ${JSON.stringify(body)}`);
  return body;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} — the MCP server needs a funded buyer account`);
  return v;
}

const TOOLS = [
  {
    name: "list_capabilities",
    description:
      "List the jobs this service sells, with per-unit prices and limits, read live from its manifest. Free.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "quote_job",
    description:
      "Get a firm price for a job without paying. Returns the planned steps and pages so you can judge the cost before committing.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "Capability name from list_capabilities" },
        params: { type: "object", description: "Job parameters" },
      },
      required: ["capability"],
    },
  },
  {
    name: "buy_job",
    description:
      "Quote, pay and run a job. SPENDS REAL HBAR. Returns the result plus a receipt locator (topic and sequence number) that anyone can verify independently.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string" },
        params: { type: "object" },
        maxTinybar: {
          type: "string",
          description: "Refuse to pay more than this. Strongly recommended.",
        },
      },
      required: ["capability"],
    },
  },
];

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ledger-of-work", version: "0.1.0" },
      };
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      let result: unknown;

      if (name === "list_capabilities") {
        const m = await getManifest();
        result = { capabilities: m.capabilities, receipts: m.receipts, payment: m.payment };
      } else if (name === "quote_job") {
        result = await quote(args.capability as string, args.params ?? {});
      } else if (name === "buy_job") {
        result = await buy(
          args.capability as string,
          args.params ?? {},
          args.maxTinybar as string | undefined,
        );
      } else {
        throw new Error(`unknown tool: ${name}`);
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });

for await (const line of rl) {
  if (!line.trim()) continue;
  let id: unknown = null;
  try {
    const msg = JSON.parse(line) as { id?: unknown; method: string; params?: Record<string, unknown> };
    id = msg.id ?? null;

    const result = await handle(msg.method, msg.params ?? {});

    // Notifications carry no id and must not be answered.
    if (msg.id === undefined) continue;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  } catch (err) {
    if (id === null) continue;
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } })}\n`,
    );
  }
}
