import { randomUUID } from "node:crypto";
import { fitToBudget, getCapability, offerFor } from "@low/worker";

/**
 * The A2A negotiation endpoint.
 *
 * ── Why a seller needs one at all ───────────────────────────────────────────────
 * The agent card has always described what is for sale, and x402 has always settled it.
 * What sat between them was nothing: a buying agent had to ask for a job at a size it
 * picked blind, and either afford the answer or not. An agent with a budget and no idea
 * what a budget buys is in exactly the position the card was supposed to save it from.
 *
 * ── Messages, not tasks ─────────────────────────────────────────────────────────
 * A2A calls this the hybrid pattern, and it is the right one here: `Message` objects
 * carry the lightweight back-and-forth that establishes *what should be done*, and a
 * `Task` is created only once there is committed work. Negotiating is messages; the job
 * itself is already a task tracked over SSE and settled through x402, so this endpoint
 * stops at the point of agreement and hands back a run URL.
 *
 * ── What is actually negotiable ─────────────────────────────────────────────────
 * Scope, never price. See `packages/worker/src/negotiate.ts` — the price is a pure
 * function of a published book and the verifier checks it, so a discount here would
 * produce a receipt that fails its own audit. A budget too small for the job comes back
 * as a smaller job at the same published rate, and the buyer decides.
 */

/** One negotiation, held until the buyer accepts or wanders off. */
interface Conversation {
  capability: string;
  /** Normalised parameters for whatever is currently on the table. */
  params: unknown;
  priceTinybar: string;
  asset: string;
  expiresAt: number;
}

const CONVERSATION_TTL_MS = 5 * 60_000;

export interface A2ADeps {
  /** Mint a real quote once terms are agreed, returning what the buyer needs to pay. */
  quote(
    capability: string,
    params: unknown,
    asset: string,
  ): Promise<{ jobId: string; run: string; amount: string; expiresAt: string }>;
  assets: string[];
}

/** JSON-RPC error codes. -32601/-32602 are the standard ones; the rest are A2A's range. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export class A2AServer {
  private readonly talks = new Map<string, Conversation>();

  constructor(private readonly deps: A2ADeps) {}

  private sweep(): void {
    const now = Date.now();
    for (const [id, c] of this.talks) if (c.expiresAt < now) this.talks.delete(id);
  }

  /** Handle one JSON-RPC request and return the body to send back. */
  async handle(body: unknown): Promise<Record<string, unknown>> {
    const req = body as { id?: unknown; method?: string; params?: Record<string, unknown> };
    const id = req?.id ?? null;

    // `message/send` is the JSON-RPC method name; the REST binding spells the same thing
    // `SendMessage`. Accept both rather than making a client guess which one we read.
    if (req?.method !== "message/send" && req?.method !== "SendMessage") {
      return rpcError(id, METHOD_NOT_FOUND, `unknown method ${String(req?.method)}`);
    }

    const message = req.params?.message as
      | { parts?: Array<Record<string, unknown>>; contextId?: string; context_id?: string }
      | undefined;
    if (!message) return rpcError(id, INVALID_PARAMS, "params.message is required");

    const data = firstDataPart(message.parts);
    if (!data) {
      return rpcError(id, INVALID_PARAMS, "expected a data part describing the job or an acceptance");
    }
    const contextId = message.contextId ?? message.context_id;

    this.sweep();
    try {
      const result = data.accept
        ? await this.accept(contextId)
        : await this.open(data, contextId);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      return rpcError(id, INVALID_PARAMS, (err as Error).message);
    }
  }

  /** A buyer states what it wants and what it can spend. */
  private async open(
    data: Record<string, unknown>,
    existingContext: string | undefined,
  ): Promise<Record<string, unknown>> {
    const capability = String(data.capability ?? "");
    const adapter = getCapability(capability);
    if (!adapter) {
      throw new Error(
        `unknown capability ${capability || "(none given)"} — read /.well-known/agent-card.json`,
      );
    }

    const asset = String(data.asset ?? this.deps.assets[0]);
    if (!this.deps.assets.includes(asset)) {
      throw new Error(`cannot settle in ${asset}; this seller takes ${this.deps.assets.join(", ")}`);
    }

    const params = adapter.normalise(data.params);
    const contextId = existingContext ?? randomUUID();

    // No budget means no negotiation to have: quote it and let the buyer decide, which is
    // the behaviour that existed before this endpoint did.
    const budget = data.budgetTinybar === undefined ? null : String(data.budgetTinybar);
    if (budget === null) {
      const offer = offerFor(adapter, params);
      this.remember(contextId, capability, offer.params, offer.priceTinybar, asset);
      return agentMessage(contextId, `Quoted at ${offer.priceTinybar} tinybar.`, {
        outcome: "quoted",
        offer: describe(capability, offer),
      });
    }

    const fit = fitToBudget(adapter, params, budget);

    if (fit.kind === "fits") {
      this.remember(contextId, capability, fit.offer.params, fit.offer.priceTinybar, asset);
      return agentMessage(
        contextId,
        `Yes — ${fit.offer.priceTinybar} tinybar, within your ${budget}. Accept to get a run URL.`,
        { outcome: "accepted", offer: describe(capability, fit.offer) },
      );
    }

    if (fit.kind === "counter") {
      this.remember(contextId, capability, fit.offer.params, fit.offer.priceTinybar, asset);
      return agentMessage(
        contextId,
        `That job costs ${fit.asked.priceTinybar} tinybar, over your ${budget}. ` +
          `For ${fit.offer.priceTinybar} I can do ${scopeText(fit.offer.params)} — ` +
          `same published rate, less work. Accept to take it.`,
        {
          outcome: "counter-offer",
          asked: describe(capability, fit.asked),
          offer: describe(capability, fit.offer),
          // Said explicitly so a buying agent can check it rather than trust the prose.
          negotiated: "scope",
          priceBook: adapter.spec.priceBook,
        },
      );
    }

    // Nothing fits. The floor price is the useful thing to say — it tells the buyer what
    // budget would work, which "no" on its own does not.
    return agentMessage(
      contextId,
      fit.reason === "not-divisible"
        ? `This capability cannot be made smaller, and costs ${fit.floor.priceTinybar} tinybar.`
        : `Even the smallest job here costs ${fit.floor.priceTinybar} tinybar, over your ${budget}.`,
      {
        outcome: "rejected",
        reason: fit.reason,
        floor: describe(capability, fit.floor),
        priceBook: adapter.spec.priceBook,
      },
    );
  }

  /** The buyer takes what is on the table; turn it into a payable quote. */
  private async accept(contextId: string | undefined): Promise<Record<string, unknown>> {
    if (!contextId) throw new Error("accepting needs the contextId of the offer being accepted");
    const talk = this.talks.get(contextId);
    if (!talk) throw new Error("no open offer for that contextId — it may have expired");

    const quote = await this.deps.quote(talk.capability, talk.params, talk.asset);

    // The price is checked against what was offered rather than assumed to match. The
    // quote is minted by the same pricing code, so a divergence is a bug — but this is
    // the seam where a buyer would be overcharged against an agreed number, so it is
    // worth one comparison to guarantee that cannot happen quietly.
    if (quote.amount !== talk.priceTinybar) {
      this.talks.delete(contextId);
      throw new Error(
        `the quote came back at ${quote.amount} tinybar but ${talk.priceTinybar} was agreed; nothing was charged`,
      );
    }

    this.talks.delete(contextId);
    return agentMessage(contextId, `Agreed at ${quote.amount} tinybar. Pay the run URL with x402.`, {
      outcome: "agreed",
      jobId: quote.jobId,
      run: quote.run,
      amount: quote.amount,
      asset: talk.asset,
      expiresAt: quote.expiresAt,
      settlement: "x402",
    });
  }

  private remember(
    contextId: string,
    capability: string,
    params: unknown,
    priceTinybar: string,
    asset: string,
  ): void {
    this.talks.set(contextId, {
      capability,
      params,
      priceTinybar,
      asset,
      expiresAt: Date.now() + CONVERSATION_TTL_MS,
    });
  }
}

/** A2A `Message` with the agent's words and a data part a machine can act on. */
function agentMessage(
  contextId: string,
  text: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "message",
    role: "agent",
    messageId: randomUUID(),
    contextId,
    parts: [{ kind: "text", text }, { kind: "data", data }],
  };
}

function describe(capability: string, offer: { params: unknown; plan: unknown; priceTinybar: string }) {
  return {
    capability,
    params: offer.params,
    plan: offer.plan,
    priceTinybar: offer.priceTinybar,
    unit: "tinybar",
  };
}

function scopeText(params: unknown): string {
  const max = (params as { max?: number })?.max;
  return typeof max === "number" ? `${max} records` : "a smaller job";
}

/**
 * The first data part, whatever spelling the client used.
 *
 * A2A's JSON binding puts structured content at `part.data`; the protobuf shape has the
 * same field and some clients send `{kind:"data", data:{...}}` while others send the bare
 * object. Reading all of them costs three lines and saves a class of silent rejection.
 */
function firstDataPart(
  parts: Array<Record<string, unknown>> | undefined,
): Record<string, unknown> | null {
  for (const part of parts ?? []) {
    const data = part.data ?? (part.kind === "data" ? part : undefined);
    if (data && typeof data === "object") return data as Record<string, unknown>;
  }
  return null;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
