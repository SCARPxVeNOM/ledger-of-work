import { isHbar, tinybarToAssetUnits, type AssetSpec } from "./assets.js";
import { canonical, hashCanonical } from "./canonical.js";
import { consensusTimestampToMillis } from "./hedera.js";
import { price } from "./price.js";
import {
  HCS_CHUNK_BYTES,
  RECEIPT_VERSION,
  type CheckResult,
  type PriceBook,
  type Receipt,
} from "./types.js";

/** A topic message as the mirror node REST API returns it. */
export interface MirrorTopicMessage {
  consensus_timestamp: string;
  message: string; // base64
  payer_account_id: string;
  running_hash: string;
  running_hash_version: number;
  sequence_number: number;
  topic_id: string;
  chunk_info?: { number: number; total: number } | null;
}

/** A transaction as the mirror node REST API returns it (the `nonce: 0` entry). */
export interface MirrorTransaction {
  transaction_id: string;
  result: string;
  consensus_timestamp: string;
  transfers: Array<{ account: string; amount: number; is_approval: boolean }>;
  token_transfers?: Array<{ token_id: string; account: string; amount: number }>;
}

export interface VerifyInput {
  /** The result the buyer holds, parsed. Hashed and compared against the receipt. */
  result: unknown;
  /** The HCS message at the receipt locator. */
  message: MirrorTopicMessage;
  /** The account the service is expected to submit receipts from. */
  expectedSubmitter: string;
  /** The published price book for the capability named in the receipt. */
  priceBook?: PriceBook | undefined;
  /**
   * The asset the receipt was settled in. Required to check the meter when payment was
   * not in HBAR, because the price book is published in tinybars and the receipt records
   * the converted amount.
   */
  asset?: AssetSpec | undefined;
  /** The settlement transaction, if the caller resolved it. Enables the payment checks. */
  transaction?: MirrorTransaction | undefined;
  /** How far after `finishedAt` a consensus timestamp may fall before it looks wrong. */
  maxSettlementLagMs?: number;
}

export interface VerifyOutput {
  ok: boolean;
  checks: CheckResult[];
  receipt?: Receipt;
}

/**
 * Re-derive every claim a receipt makes, from public inputs only.
 *
 * This function is the product. It must be runnable by someone who does not trust the
 * seller and has no access to the seller's database — so it takes the buyer's result, a
 * mirror-node message, and a mirror-node transaction, and nothing else.
 *
 * Returns checks as data rather than printing, so the CLI, the web page, and the tests
 * all render the same verdicts.
 */
export function verifyReceipt(input: VerifyInput): VerifyOutput {
  const checks: CheckResult[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string): boolean => {
    checks.push({ id, label, ok, detail });
    return ok;
  };

  // 1. The message exists and is whole.
  const chunked = (input.message.chunk_info?.total ?? 1) > 1;
  if (
    !add(
      "message",
      "Receipt message present and unchunked",
      Boolean(input.message.message) && !chunked,
      chunked
        ? `message spans ${input.message.chunk_info?.total} chunks; REST does not reassemble — fetch and concatenate by chunk_info.number`
        : `topic ${input.message.topic_id} sequence ${input.message.sequence_number}`,
    )
  ) {
    return { ok: false, checks };
  }

  // 2. Only the service may write to this topic. Without this, anyone can forge a receipt.
  add(
    "submitter",
    "Submitted by the expected service account",
    input.message.payer_account_id === input.expectedSubmitter,
    `submitted by ${input.message.payer_account_id}, expected ${input.expectedSubmitter}`,
  );

  // 3. The payload parses as a receipt we understand.
  let receipt: Receipt;
  try {
    const decoded = Buffer.from(input.message.message, "base64").toString("utf8");
    receipt = JSON.parse(decoded) as Receipt;
  } catch (err) {
    add("parse", "Receipt parses", false, `undecodable: ${(err as Error).message}`);
    return { ok: false, checks };
  }
  if (
    !add(
      "parse",
      "Receipt parses at a known schema version",
      receipt.v === RECEIPT_VERSION,
      `v=${String(receipt.v)}, this verifier understands v=${RECEIPT_VERSION}`,
    )
  ) {
    return { ok: false, checks, receipt };
  }

  // 4. The integrity claim: the bytes the buyer holds are the bytes that were recorded.
  const actualHash = hashCanonical(input.result);
  add(
    "result",
    "Result matches the recorded hash",
    actualHash === receipt.resultHash,
    actualHash === receipt.resultHash
      ? actualHash
      : `computed ${actualHash}, receipt claims ${receipt.resultHash}`,
  );

  // 5. The timing claim: consensus happened at or after the job finished, and close to it.
  const finishedAt = Date.parse(receipt.finishedAt);
  const consensusMs = consensusTimestampToMillis(input.message.consensus_timestamp);
  const lag = consensusMs - finishedAt;
  const maxLag = input.maxSettlementLagMs ?? 5 * 60_000;
  add(
    "timing",
    "Consensus timestamp is coherent with the claimed finish",
    Number.isFinite(finishedAt) && lag >= 0 && lag <= maxLag,
    `consensus is ${lag}ms after finishedAt (allowed 0..${maxLag}ms)`,
  );

  // 6. The payment claim.
  if (input.transaction) {
    const tx = input.transaction;
    const payingInHbar = isHbar(receipt.payment.asset);

    // An HTS payment moves no HBAR to the seller, so reading `transfers` would see zero
    // and fail every token settlement. The transfers to inspect depend on the asset.
    const credits = payingInHbar
      ? tx.transfers.map((t) => ({ account: t.account, amount: t.amount }))
      : (tx.token_transfers ?? [])
          .filter((t) => t.token_id === receipt.payment.asset)
          .map((t) => ({ account: t.account, amount: t.amount }));

    const paidToSeller = credits
      .filter((t) => t.account === receipt.payment.payTo && t.amount > 0)
      .reduce((sum, t) => sum + BigInt(t.amount), 0n);
    const charged = BigInt(receipt.price.charged);

    add(
      "payment",
      "Settlement succeeded for exactly the charged amount",
      tx.result === "SUCCESS" && paidToSeller === charged,
      `result=${tx.result}, ${paidToSeller} ${receipt.price.unit} to ${receipt.payment.payTo}, receipt claims ${charged}`,
    );

    // The named buyer must actually appear as a net sender. This is what ties the
    // identity in the receipt to the on-chain event, and it is the reason the buyer is
    // captured from /verify rather than read back out of the transaction id.
    const payerSent = credits.some((t) => t.account === receipt.payment.payer && t.amount < 0);
    add(
      "payer",
      "Named paying agent is a net sender in the transaction",
      payerSent,
      payerSent
        ? `${receipt.payment.payer} debited`
        : `${receipt.payment.payer} does not appear as a sender`,
    );
  } else {
    add("payment", "Settlement transaction", false, "not supplied — pass one to check payment");
  }

  // 7. The meter claim: the quote follows from the published price book applied to the
  // plan, and the buyer was charged exactly what they were quoted.
  //
  // Checking `charged` against the *actual* work would be wrong. Hedera offers only the
  // `exact` scheme, so the buyer signs for one definite amount before the work happens;
  // when reality differs from the plan the seller absorbs it. What is verifiable is that
  // the quote was computed honestly and was not inflated after the fact.
  if (input.priceBook) {
    const quotedFromPlan = price(
      { steps: receipt.plan.steps, pages: receipt.plan.pages, sessionMs: receipt.plan.estimatedMs },
      input.priceBook,
    );
    // The price book is published in tinybars. When the buyer paid in a token, the
    // receipt records the converted amount, so the comparison has to convert too.
    const expectedQuote = input.asset
      ? tinybarToAssetUnits(quotedFromPlan.total, input.asset)
      : quotedFromPlan.total.toString();
    const quoteHonest = expectedQuote === receipt.price.quoted;
    const chargedAsQuoted = receipt.price.charged === receipt.price.quoted;

    add(
      "meter",
      "Quote follows the published price book",
      quoteHonest,
      `plan ${JSON.stringify(receipt.plan)} prices at ${expectedQuote} ${receipt.price.unit}, receipt quoted ${receipt.price.quoted}`,
    );
    add(
      "charge",
      "Charged exactly what was quoted",
      chargedAsQuoted,
      chargedAsQuoted
        ? `${receipt.price.charged} ${receipt.price.unit}`
        : `quoted ${receipt.price.quoted}, charged ${receipt.price.charged}`,
    );

    // Informational, not a pass/fail: it shows who absorbed the difference between the
    // estimate and reality. A meter that never diverges is a flat fee in disguise.
    const actualRaw = price(receipt.work, input.priceBook);
    const actual = input.asset
      ? BigInt(tinybarToAssetUnits(actualRaw.total, input.asset))
      : actualRaw.total;
    const variance = actual - BigInt(receipt.price.charged);
    add(
      "variance",
      "Work performed, priced for comparison",
      true,
      `actual work prices at ${actual} ${receipt.price.unit}; ${
        variance === 0n
          ? "matches the charge exactly"
          : variance > 0n
            ? `${variance} ${receipt.price.unit} more than charged, absorbed by the seller`
            : `${-variance} ${receipt.price.unit} less than charged, the plan overestimated`
      }`,
    );
  } else {
    add("meter", "Quote follows the published price book", false, "no price book supplied");
  }

  return { ok: checks.every((c) => c.ok), checks, receipt };
}

/**
 * A receipt that exceeds one HCS chunk still works, but forces every reader to reassemble
 * chunks from the REST API by hand. Keeping it under the limit is a design constraint, so
 * assert it where receipts are built rather than discovering it in production.
 */
export function fitsOneChunk(receipt: Receipt): boolean {
  return Buffer.byteLength(canonical(receipt), "utf8") <= HCS_CHUNK_BYTES;
}
