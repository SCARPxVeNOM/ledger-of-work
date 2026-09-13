import {
  hashCanonical,
  sha256,
  type EvidenceRef,
  type Receipt,
  type RetrievalRef,
  RECEIPT_VERSION,
} from "@low/protocol";
import { proveRetrieval, summarise, type RetrievalProof } from "@low/proof";
import {
  DEFAULT_USER_AGENT,
  JobAbortedError,
  runJob,
  type SiteAdapter,
  type StepEvent,
} from "@low/worker";
import type { Browser } from "playwright";
import type { ReceiptLocator, ReceiptPublisher } from "@low/receipts";
import type { Quote } from "./quote-store.js";
import {
  resolvePayer,
  settlementTxId,
  type FacilitatorClient,
  type PaymentPayload,
  type PaymentRequirements,
} from "./facilitator.js";

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
  /**
   * Enables retrieval proofs. Without it, jobs still run and receipts still publish —
   * they simply carry no third-party witness, and the verifier says so.
   */
  zkOwnerKey?: string;
}

export interface ExecuteOutcome {
  ok: boolean;
  result?: unknown;
  /** Artifacts the buyer needs to check the evidence hashes themselves. */
  artifacts?: { html: string; screenshotBase64: string };
  /** The attestor's signed claim, far too large for a receipt. Hashed into it instead. */
  retrievalProof?: RetrievalProof;
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
 *   verify -> execute -> hash -> settle -> publish receipt -> respond
 *
 * `verify` first because it is free and rejects a bad payment before we spend real work.
 * `settle` before publishing because the receipt's whole value is binding the delivered
 * result to the payment that bought it, and a receipt written before settlement cannot
 * carry a transaction id. That ordering leaves a short window — roughly the two seconds
 * between settlement and consensus — in which a crash would mean a charge with no
 * record; `publishWithRetry` below narrows it, and the risk is stated in the README
 * rather than hidden.
 *
 * Both failure paths still publish. A job that fails settles nothing and charges zero,
 * and a settlement that fails is recorded as such. A log that only records successes
 * proves nothing.
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
  let evidence: EvidenceRef | undefined;
  let artifacts: { html: string; screenshotBase64: string } | undefined;
  let retrieval: RetrievalRef | undefined;
  let retrievalProof: RetrievalProof | undefined;
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
    if (run.evidence) {
      // Hash the artifacts exactly as delivered, so the buyer's re-hash matches ours.
      evidence = {
        pageHash: sha256(Buffer.from(run.evidence.html, "utf8")),
        screenshotHash: sha256(run.evidence.screenshot),
        finalUrl: run.evidence.finalUrl,
      };
      artifacts = {
        html: run.evidence.html,
        screenshotBase64: run.evidence.screenshot.toString("base64"),
      };

      // Ask a third party to vouch for the response, if this capability can point at one
      // and we have a key to own the proof with.
      //
      // Deliberately after the answer exists and deliberately unable to fail the job: a
      // buyer who paid for a capture that succeeded must get their capture even if an
      // attestor is down. The receipt then carries no `retrieval`, and the verifier
      // reports that as unproven rather than quietly passing.
      const target = deps.adapter.provable?.(quote.params, run.items, {
        finalUrl: run.evidence.finalUrl,
        html: run.evidence.html,
      });
      if (target && deps.zkOwnerKey) {
        const proof = await proveRetrieval({
          url: target.url,
          mustContain: target.mustContain,
          ownerPrivateKey: deps.zkOwnerKey,
          headers: { "user-agent": DEFAULT_USER_AGENT, accept: "text/html" },
        });
        if (proof) {
          retrievalProof = proof;
          retrieval = summarise(proof);
        }
      }
    }
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

  // A run that finished without error has still not necessarily delivered anything. The
  // capability decides, because the answer differs by kind: an empty *search* is a real
  // answer, an empty *capture* is a miss. `exact` admits no partial settlement — the
  // buyer signed for one number — so the only honest options are that number or nothing.
  if (!failure) {
    const check = deps.adapter.delivered?.(items as never[], quote.params as never);
    if (check && !check.ok) failure = check.why;
  }

  // Cap and absorb: the buyer signed for the quoted amount and `exact` admits no other
  // number, so an overrun is the seller's cost. The receipt records the plan and the
  // actual work side by side, which is what makes the absorption visible rather than
  // something the seller can quietly pocket.
  const charged = failure ? "0" : quote.assetAmount;

  const result = failure ? undefined : { capability: quote.capability, params: quote.params, items };
  const resultHash = failure ? "sha256:" + "0".repeat(64) : hashCanonical(result);

  const receipt: Receipt = {
    v: RECEIPT_VERSION,
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
    ...(evidence ? { evidence } : {}),
    ...(retrieval ? { retrieval } : {}),
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
    const locator = await publishWithRetry(deps.publisher, receipt);
    return { ok: false, receipt, locator, charged: "0", error: failure };
  }

  const settle = await deps.facilitator.settle(payload, requirements);
  if (!settle.success) {
    receipt.status = "failed";
    receipt.price.charged = "0";
    const locator = await publishWithRetry(deps.publisher, receipt);
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

  const locator = await publishWithRetry(deps.publisher, receipt);
  return {
    ok: true,
    result,
    ...(artifacts ? { artifacts } : {}),
    ...(retrievalProof ? { retrievalProof } : {}),
    receipt,
    locator,
    charged: quote.assetAmount,
  };
}

/**
 * Publish a receipt, retrying a few times before giving up.
 *
 * This is the mitigation for the one genuinely bad outcome in the lifecycle: money has
 * moved and no record exists. A transient consensus-node error should not be enough to
 * cause it. If every attempt fails the error propagates — the caller must not report
 * success for a job whose receipt never landed.
 */
async function publishWithRetry(
  publisher: ReceiptPublisher,
  receipt: Receipt,
  attempts = 3,
): Promise<ReceiptLocator> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await publisher.publish(receipt);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error(
    `receipt for job ${receipt.jobId} could not be published after ${attempts} attempts: ${(lastError as Error)?.message}`,
  );
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
