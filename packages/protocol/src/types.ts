/**
 * Receipt schema version. Bump on any field change — an immutable log cannot be migrated.
 *
 * v2 added `evidence`; v3 added `retrieval`. Receipts already written at v1 stay readable
 * and verifiable forever, because the alternative to supporting them is a log with a hole
 * in it.
 */
export const RECEIPT_VERSION = 3;

/** Versions this build can read. Anything else is refused rather than guessed at. */
export const SUPPORTED_RECEIPT_VERSIONS = [1, 2, 3] as const;

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
  /**
   * Rates for units beyond the reserved three, keyed by unit name.
   *
   * Optional because every price book written before generic metering existed prices
   * steps, pages and seconds and has nothing else to say. A unit with no rate here is
   * refused rather than charged nothing — see `price`.
   */
  per?: Record<string, string>;
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
  /**
   * When the page was captured. Dropped from v3 onward: it was always within a few
   * milliseconds of `finishedAt`, which the receipt already carries, and at v3 the
   * budget is tight enough that 40 bytes of restated fact is 40 bytes of sources.
   * Still read on v2 receipts, which have it.
   */
  capturedAt?: string;
}

/**
 * A commitment to a third party's word that the response was real.
 *
 * The evidence bundle is all seller-produced, so a seller willing to fabricate can
 * fabricate it coherently. This is the one field on the receipt that is not: an
 * independent attestor observed the TLS session and signed for it, and we do not hold
 * the key that produced that signature.
 *
 * The proof itself is a few kilobytes and cannot go in a 1024-byte receipt, so it is
 * returned to the buyer alongside the result and only its hash is committed here —
 * exactly as the result payload is handled.
 *
 * Absent whenever the attestor could not be reached, refused, or the source needs
 * credentials we will not hand to a third party. A verifier must read its absence as
 * unproven, never as fine.
 */
export interface RetrievalRef {
  /**
   * `sha256:<hex>` over the canonical encoding of the proof handed to the buyer.
   *
   * A pointer and nothing else, for the same reason `resultHash` is: the proof runs to
   * several kilobytes and the whole receipt gets 1024 bytes. Who signed it and what they
   * matched on are both *in* the proof, and a checker cannot do anything without holding
   * the proof anyway — so restating either here would spend real budget, measured at 56
   * and 61 bytes, to repeat what the verifier already has in hand.
   *
   * This was not a free choice. A v3 receipt carrying both this and the evidence hashes
   * came to 1026 bytes against a hard 1024-byte chunk limit, and HCS messages that span
   * chunks cannot be read back through the mirror REST API at all — which would make the
   * receipt unverifiable by exactly the people it exists for.
   */
  proofHash: string;
}

export interface Receipt {
  /** 1 for receipts written before evidence existed; 2 adds it, 3 adds retrieval proof. */
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
  /**
   * Absent on v1 and v2, and on v3 jobs where no proof could be obtained. Unproven, not
   * fine — see `RetrievalRef`.
   */
  retrieval?: RetrievalRef;
  status: JobStatus;
}

/** One line of the verifier's output. Data, not prose, so callers can render it anywhere. */
export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /**
   * True when this check could not be run at all, as distinct from having failed.
   *
   * The difference is the whole reason this field exists. "The screenshot does not match"
   * and "you did not give me the screenshot" are both `ok: false`, and treating them the
   * same means a receipt is stamped VOID for a capability that legitimately cannot carry
   * a retrieval proof — which accuses the seller of something on the basis of a check
   * nobody ran.
   *
   * Stamping such a receipt VERIFIED would be the opposite overclaim. So the verdict has
   * three states, and this is what separates the middle one from the bad one.
   */
  unchecked?: boolean;
}
