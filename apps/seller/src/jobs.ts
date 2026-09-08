import { randomUUID } from "node:crypto";
import { hashCanonical, type AssetSpec, type PriceBook, type Receipt } from "@low/protocol";
import { JobAbortedError, runJob, type SiteAdapter, type StepEvent } from "@low/worker";
import type { Browser } from "playwright";
import type { ReceiptPublisher, ReceiptLocator } from "@low/receipts";
import {
  resolvePayer,
  settlementTxId,
  type FacilitatorClient,
  type PaymentPayload,
  type PaymentRequirements,
} from "./facilitator.js";

export interface Quote {
  jobId: string;
  capability: string;
  params: unknown;
  /**
   * What the plan expects to do, shown to the buyer so the price is legible and written
   * into the receipt so a verifier can confirm the quote followed the price book.
   */
  plan: { steps: number; pages: number; estimatedMs: number; outline: string[] };
  /** Integer tinybars — the metered price, independent of how it is paid. */
  amount: string;
  /** The asset the buyer will actually pay in. */
  asset: AssetSpec;
  /** `amount` converted into that asset's smallest units. This is what gets signed. */
  assetAmount: string;
  priceBook: PriceBook;
  expiresAt: string;
  createdAt: number;
}

/** Quotes are short-lived so a buyer cannot bank a cheap one and redeem it much later. */
export const QUOTE_TTL_MS = 5 * 60_000;

export class QuoteStore {
  readonly #quotes = new Map<string, Quote>();

  create(
    capability: string,
    params: unknown,
    plan: Quote["plan"],
    amount: string,
    priceBook: PriceBook,
    asset: AssetSpec,
    assetAmount: string,
  ): Quote {
    const quote: Quote = {
      jobId: randomUUID(),
      capability,
      params,
      plan,
      amount,
      asset,
      assetAmount,
      priceBook,
      createdAt: Date.now(),
      expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    };
    this.#quotes.set(quote.jobId, quote);
    return quote;
  }

  get(jobId: string): Quote | undefined {
    const quote = this.#quotes.get(jobId);
    if (!quote) return undefined;
    if (Date.now() - quote.createdAt > QUOTE_TTL_MS) {
      this.#quotes.delete(jobId);
      return undefined;
    }
    return quote;
  }

  /** A quote is consumed on use, so one payment cannot buy two jobs. */
  consume(jobId: string): Quote | undefined {
    const quote = this.get(jobId);
    if (quote) this.#quotes.delete(jobId);
    return quote;
  }

  sweep(): void {
    const cutoff = Date.now() - QUOTE_TTL_MS;
    for (const [id, q] of this.#quotes) if (q.createdAt < cutoff) this.#quotes.delete(id);
  }

  get size(): number {
    return this.#quotes.size;
  }
}

export interface ExecuteDeps {
  // biome-ignore lint/suspicious/noExplicitAny: the catalogue is heterogeneous by design
  adapter: SiteAdapter<any, any>;
  facilitator: FacilitatorClient;
  publisher: ReceiptPublisher;
  browser: Browser;
  sellerAccountId: string;
  network: string;
  /** Observe the meter live. Used by the SSE endpoint the demo UI watches. */
  onStep?: (event: StepEvent) => void;
}

export interface ExecuteOutcome {
  ok: boolean;
  result?: unknown;
  receipt: Receipt;
  locator: ReceiptLocator;
  charged: string;
  error?: string;
}

/**
 * The whole lifecycle for one paid job.
 *
 * Ordering is deliberate and load-bearing:
 *
 *   verify -> execute -> hash -> publish receipt -> settle -> respond
 *
 * `verify` first because it is free and rejects a bad payment before we spend real work.
 * `settle` last because settling first would charge for a job that then failed. The
 * receipt is published *before* settlement so a record exists even if settlement fails —
 * a second `settlement` message records the outcome. Publishing after settling would
 * risk charging with no record, which is the worse of the two failures.
 */
export async function executeJob(
  quote: Quote,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  deps: ExecuteDeps,
): Promise<ExecuteOutcome> {
  const verify = await deps.facilitator.verify(payload, requirements);
  if (!verify.isValid) {
    throw new PaymentRejectedError(verify.invalidReason ?? "unknown", verify.invalidMessage ?? "");
  }

  let items: unknown;
  let work = { steps: 0, pages: 0, sessionMs: 0 };
  let sources: string[] = [];
  let startedAt = new Date().toISOString();
  let finishedAt = startedAt;
  let failure: string | undefined;

  try {
    const run = await runJob(deps.adapter, quote.params, {
      browser: deps.browser,
      ...(deps.onStep ? { onStep: deps.onStep } : {}),
    });
    items = run.items;
    work = { steps: run.work.steps, pages: run.work.pages, sessionMs: run.work.sessionMs };
    sources = run.work.sources;
    startedAt = run.startedAt;
    finishedAt = run.finishedAt;
  } catch (err) {
    // A job that failed still did work, and that work is part of the record. But we do
    // not settle for it — see below.
    if (err instanceof JobAbortedError) {
      work = { steps: err.work.steps, pages: err.work.pages, sessionMs: err.work.sessionMs };
      sources = err.work.sources;
    }
    failure = (err as Error).message;
    finishedAt = new Date().toISOString();
  }

  // Cap and absorb: the buyer signed for the quoted amount and `exact` admits no other
  // number, so an overrun is the seller's cost. The receipt records the plan and the
  // actual work side by side, which is what makes the absorption visible rather than
  // something the seller can quietly pocket.
  const charged = failure ? "0" : quote.assetAmount;

  const result = failure ? undefined : { capability: quote.capability, params: quote.params, items };
  const resultHash = failure ? "sha256:" + "0".repeat(64) : hashCanonical(result);

  const receipt: Receipt = {
    v: 1,
    kind: "delivery",
    jobId: quote.jobId,
    capability: quote.capability,
    resultHash,
    sources,
    startedAt,
    finishedAt,
    plan: {
      steps: quote.plan.steps,
      pages: quote.plan.pages,
      estimatedMs: quote.plan.estimatedMs,
    },
    work,
    price: { unit: quote.asset.id === "0.0.0" ? "tinybar" : quote.asset.symbol, quoted: quote.assetAmount, charged },
    payment: {
      network: deps.network,
      scheme: "exact",
      asset: requirements.asset,
      payer: verify.payer ?? "unknown",
      payTo: deps.sellerAccountId,
    },
    status: failure ? "failed" : "ok",
  };

  // A failed job is never settled. On `exact` there is no zero-amount settlement to fall
  // back on, so the only honest option is not to charge. The receipt is still published:
  // a log that records only successes proves nothing.
  if (failure) {
    const locator = await deps.publisher.publish(receipt);
    return { ok: false, receipt, locator, charged: "0", error: failure };
  }

  const settle = await deps.facilitator.settle(payload, requirements);
  if (!settle.success) {
    receipt.status = "failed";
    receipt.price.charged = "0";
    const locator = await deps.publisher.publish(receipt);
    return {
      ok: false,
      receipt,
      locator,
      charged: "0",
      error: `settlement failed: ${settle.errorReason ?? ""} ${settle.errorMessage ?? ""}`.trim(),
    };
  }

  const txId = settlementTxId(settle);
  if (txId) receipt.payment.txId = txId;

  const payer = resolvePayer(verify, settle, deps.facilitator.feePayer);
  if (payer) receipt.payment.payer = payer;

  const locator = await deps.publisher.publish(receipt);
  return { ok: true, result, receipt, locator, charged: quote.assetAmount };
}

export class PaymentRejectedError extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`payment rejected: ${reason}${detail ? ` — ${detail}` : ""}`);
    this.name = "PaymentRejectedError";
  }
}
