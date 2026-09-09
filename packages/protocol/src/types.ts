/**
 * Receipt schema version. Bump on any field change — an immutable log cannot be migrated.
 *
 * v2 added `evidence`. Receipts already written at v1 stay readable and verifiable
 * forever, because the alternative to supporting them is a log with a hole in it.
 */
export const RECEIPT_VERSION = 2;

/** Versions this build can read. Anything else is refused rather than guessed at. */
export const SUPPORTED_RECEIPT_VERSIONS = [1, 2] as const;

/** HCS caps a single message chunk at 1024 bytes; the REST API does not reassemble chunks. */
export const HCS_CHUNK_BYTES = 1024;

/**
 * What the worker actually did. Every field must be countable and deterministic: the
 * verifier recomputes the price from this record, so an opinion ("difficulty: hard")
 * would make the price unverifiable.
 */
export interface StepLog {
  /** Navigations and interactions performed. */
  steps: number;
  /** Result pages traversed. */
  pages: number;
  /** Wall-clock browser session time. */
  sessionMs: number;
  /** URLs touched, in order, bounded by MAX_SOURCES to keep the receipt in one chunk. */
  sources: string[];
}

/**
 * Published per-capability unit prices, in integer tinybars. A buyer can fetch this from
 * the manifest and compute the price themselves before asking — which is what makes the
 * meter checkable rather than a number we assert.
 */
export interface PriceBook {
  /** Session setup, charged once. */
  base: string;
  /** Per navigation / interaction. */
  perStep: string;
  /** Per result page traversed. */
  perPage: string;
  /** Per wall-clock second, rounded up. */
  perSecond: string;
  /** Hard cap. A job that would exceed this aborts rather than overrun. */
  ceiling: string;
}

/**
 * Only delivery receipts are emitted. An earlier design also wrote a second
 * `settlement` message per job; it was dropped because a receipt published before
 * settlement cannot carry a transaction id, and binding the result to the payment is the
 * receipt's entire purpose. Left as a single-member union so adding a kind later is a
 * visible schema change rather than a silent one.
 */
export type ReceiptKind = "delivery";
export type JobStatus = "ok" | "partial" | "failed";

export interface PaymentRef {
  /** CAIP-2 network id, e.g. `hedera:testnet`. */
  network: string;
  scheme: "exact";
  /** `0.0.0` for HBAR, or an HTS token id. */
  asset: string;
  /** Hedera transaction id in SDK form. Absent until settlement succeeds. */
  txId?: string;
  /**
   * The buying agent's account.
   *
   * Not derivable from `txId`: the exact-Hedera scheme requires
   * `transactionId.accountId == extra.feePayer`, so the transaction id always names the
   * facilitator. Nor is it safely read from the settlement response's `payer`, which
   * means the buyer in some implementations and the fee payer in others. Take it from
   * `/verify`'s `payer`, captured before settling.
   */
  payer: string;
  payTo: string;
}

/**
 * Commitments to what the page looked like, alongside the answer taken from it.
 *
 * These do not prove the retrieval happened — a seller could render a page and screenshot
 * it. What they do is make fabrication expensive and inspectable: the buyer holds both
 * artifacts, can re-hash them, and can *look* at the screenshot to see whether it shows
 * the claim. Proving retrieval itself needs zkTLS; see the README.
 */
export interface EvidenceRef {
  /** `sha256:<hex>` over the fully rendered HTML. */
  pageHash: string;
  /** `sha256:<hex>` over the full-page PNG. */
  screenshotHash: string;
  /** Where the browser actually ended up, which may differ from where it was sent. */
  finalUrl: string;
  capturedAt: string;
}

export interface Receipt {
  /** 1 for receipts written before evidence existed; 2 onwards carry it. */
  v: number;
  kind: ReceiptKind;
  jobId: string;
  capability: string;
  /** `sha256:<hex>` over the canonical encoding of the result delivered to the buyer. */
  resultHash: string;
  sources: string[];
  /** ISO 8601, millisecond precision. */
  startedAt: string;
  finishedAt: string;
  /**
   * The work the quote was priced from.
   *
   * Recorded because `exact` settlement means the buyer pays the quoted amount and no
   * other — so the checkable claim is "the quote followed the published price book",
   * not "the charge equals the price of the work performed". Without the plan, a
   * verifier recomputing from `work` alone would flag every job where reality differed
   * from the estimate, which is most of them.
   */
  plan: { steps: number; pages: number; estimatedMs: number };
  /** What the worker actually did. Compare against `plan` to see the variance absorbed. */
  work: Omit<StepLog, "sources">;
  price: {
    /**
     * The denomination `quoted` and `charged` are expressed in: "tinybar" for HBAR, or
     * the token's symbol when settling in an HTS asset. The metered price is always
     * computed in tinybars; this records what the buyer actually signed for, which is
     * what lands on chain and what the payment check compares against.
     */
    unit: string;
    quoted: string;
    charged: string;
  };
  payment: PaymentRef;
  /**
   * Absent on v1 receipts, and on v2 jobs where the page could not be captured. A
   * verifier must treat "no evidence" as "unproven", never as "fine".
   */
  evidence?: EvidenceRef;
  status: JobStatus;
}

/** One line of the verifier's output. Data, not prose, so callers can render it anywhere. */
export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}
