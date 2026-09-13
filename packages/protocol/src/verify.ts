import { isHbar, tinybarToAssetUnits, type AssetSpec } from "./assets.js";
import { canonical } from "./canonical.js";
import { readEvidence } from "./evidence.js";
import { consensusTimestampToMillis } from "./hedera.js";
import { price } from "./price.js";
import {
  HCS_CHUNK_BYTES,
  RECEIPT_VERSION,
  SUPPORTED_RECEIPT_VERSIONS,
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
  /**
   * `sha256:<hex>` over the canonical encoding of the result the buyer holds.
   *
   * Taken precomputed rather than hashing here, because hashing is the only part of this
   * check that needs a platform primitive: Node has `node:crypto`, a browser has Web
   * Crypto, and only the latter is async. Keeping it out means this whole function stays
   * synchronous and portable, and the CLI and the browser page share it verbatim instead
   * of maintaining two verifiers that could drift apart.
   */
  resultHash: string;
  /**
   * `sha256:<hex>` over the page HTML and screenshot the buyer received.
   *
   * Omitted when the buyer did not keep the artifacts. The evidence checks then report
   * as unproven rather than passing, because a check that silently succeeds on missing
   * input is worse than no check.
   */
  pageHash?: string | undefined;
  screenshotHash?: string | undefined;
  /**
   * Artifacts by the names the receipt used, for receipts that commit to more than a
   * page and a screenshot. `pageHash` and `screenshotHash` above are the older way of
   * saying the same thing and still work; where both are given, they win.
   */
  artifacts?: Record<string, string> | undefined;
  /**
   * `sha256:<hex>` over the retrieval proof the buyer received, hashed by the caller for
   * the same reason `resultHash` is.
   */
  retrievalProofHash?: string | undefined;
  /**
   * Whether that proof actually covers the answer sold, decided by the caller.
   *
   * Passed in rather than computed here because it needs to parse the proof, and this
   * module is deliberately the one thing both verifiers share verbatim. The *signature*
   * check cannot live here at all — it needs the attestor SDK and is asynchronous — so a
   * caller that can verify signatures appends that check itself.
   */
  retrievalCoverage?: { ok: boolean; detail: string } | undefined;
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

  /**
   * A check that could not be run, as distinct from one that failed.
   *
   * Always `ok: false` — nothing here has been proven — but flagged so the verdict can
   * tell "this is wrong" apart from "you did not give me enough to say".
   */
  const cannotCheck = (id: string, label: string, detail: string): void => {
    checks.push({ id, label, ok: false, unchecked: true, detail });
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
    receipt = JSON.parse(decodeBase64Utf8(input.message.message)) as Receipt;
  } catch (err) {
    add("parse", "Receipt parses", false, `undecodable: ${(err as Error).message}`);
    return { ok: false, checks };
  }
  if (
    !add(
      "parse",
      "Receipt parses at a known schema version",
      (SUPPORTED_RECEIPT_VERSIONS as readonly number[]).includes(receipt.v),
      `v=${String(receipt.v)}, this verifier reads v=${SUPPORTED_RECEIPT_VERSIONS.join(", ")} (current ${RECEIPT_VERSION})`,
    )
  ) {
    return { ok: false, checks, receipt };
  }

  // 4. The integrity claim: the bytes the buyer holds are the bytes that were recorded.
  const actualHash = input.resultHash;
  add(
    "result",
    "Result matches the recorded hash",
    actualHash === receipt.resultHash,
    actualHash === receipt.resultHash
      ? actualHash
      : `computed ${actualHash}, receipt claims ${receipt.resultHash}`,
  );

  // 4b. What the page looked like.
  //
  // Reported as three states, never two: matched, mismatched, or not checkable. A
  // receipt that carries no evidence is not thereby fine — it is unproven, and saying so
  // is the difference between a verifier and a rubber stamp.
  const committed = readEvidence(receipt).artifacts;
  if (Object.keys(committed).length > 0) {
    // Whatever the receipt committed to, by the names it used. Two of those names are
    // older than the rest and keep their wording, so a reader who has seen this output
    // before still recognises it.
    const supplied: Record<string, string | undefined> = {
      ...input.artifacts,
      ...(input.pageHash === undefined ? {} : { pageHash: input.pageHash }),
      ...(input.screenshotHash === undefined ? {} : { screenshotHash: input.screenshotHash }),
    };
    const LABELS: Record<string, [string, string]> = {
      pageHash: ["page", "Page HTML matches the recorded hash"],
      screenshotHash: ["screenshot", "Screenshot matches the recorded hash"],
    };

    const rows: Array<[string, string, string | undefined, string]> = Object.entries(committed).map(
      ([name, hash]) => {
        const [id, label] = LABELS[name] ?? [name, `\`${name}\` matches the recorded hash`];
        return [id, label, supplied[name], hash];
      },
    );

    for (const [id, label, supplied, recorded] of rows) {
      if (supplied === undefined) {
        cannotCheck(id, label, `not checked — supply the artifact to compare against ${recorded}`);
      } else {
        add(
          id,
          label,
          supplied === recorded,
          supplied === recorded ? recorded : `computed ${supplied}, receipt claims ${recorded}`,
        );
      }
    }
  } else if (receipt.v >= 2) {
    cannotCheck(
      "page",
      "Page HTML matches the recorded hash",
      `this v${receipt.v} receipt records no evidence — the page could not be captured`,
    );
  }

  // 4c. Whether a third party will vouch for the response.
  //
  // Everything checked so far is seller-produced: fabricate the answer, hash the
  // fabrication, screenshot the fabrication, and it all still passes. This is the only
  // check whose subject is a signature we could not have produced.
  //
  // Reported the same three ways as the evidence, and for a stronger reason: a receipt
  // with no retrieval proof is exactly as trustworthy as the seller, which is what this
  // whole exercise exists to stop assuming.
  if (receipt.retrieval) {
    if (input.retrievalProofHash === undefined) {
      cannotCheck(
        "retrieval-hash",
        "Retrieval proof is the one the receipt committed to",
        `not checked — supply the proof to compare against ${receipt.retrieval.proofHash}`,
      );
    } else {
      const matches = input.retrievalProofHash === receipt.retrieval.proofHash;
      add(
        "retrieval-hash",
        "Retrieval proof is the one the receipt committed to",
        matches,
        matches
          ? receipt.retrieval.proofHash
          : `computed ${input.retrievalProofHash}, receipt claims ${receipt.retrieval.proofHash}`,
      );
    }

    if (input.retrievalCoverage === undefined) {
      cannotCheck(
        "retrieval-coverage",
        "The witnessed response covers the answer sold",
        `not checked — supply the proof returned beside the result, which the receipt commits to as ${receipt.retrieval.proofHash}`,
      );
    } else {
      add(
        "retrieval-coverage",
        "The witnessed response covers the answer sold",
        input.retrievalCoverage.ok,
        input.retrievalCoverage.detail,
      );
    }
  } else if (receipt.v >= 3) {
    // Not a failure. Most capabilities cannot carry a retrieval proof at all — proving a
    // credentialed request costs 28 seconds against 2 — so failing them for its absence
    // would stamp VOID on every job that was never going to have one.
    cannotCheck(
      "retrieval-hash",
      "Retrieval proof is the one the receipt committed to",
      "this receipt carries no retrieval proof — the answer is only as good as the seller's word",
    );
  }

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
    // Not a failure — a question nobody asked. Without a price book there is nothing to
    // compare the quote against, so calling it false accuses the seller of overcharging
    // on the strength of a missing input. It stamped VOID on sound receipts, and on the
    // hosted verifier it did so by default, because the capability selector starts on
    // "skip the meter check".
    cannotCheck(
      "meter",
      "Quote follows the published price book",
      "not checked — choose the capability to compare against its published book",
    );
  }

  // A verdict, not a score: anything that actually failed makes this false, while checks
  // that could not be run leave it true and are reported as unchecked in their own right.
  return { ok: checks.every((c) => c.ok || c.unchecked), checks, receipt };
}

/**
 * A receipt that exceeds one HCS chunk still works, but forces every reader to reassemble
 * chunks from the REST API by hand. Keeping it under the limit is a design constraint, so
 * assert it where receipts are built rather than discovering it in production.
 */
export function fitsOneChunk(receipt: Receipt): boolean {
  return new TextEncoder().encode(canonical(receipt)).length <= HCS_CHUNK_BYTES;
}

/**
 * Trim a receipt until it fits one HCS chunk, dropping sources from the end.
 *
 * Adding evidence hashes left only ~39 bytes of headroom on a typical receipt, which is
 * not a margin — one longer URL and receipts start chunking, which silently breaks every
 * REST reader. `sources` is the only unbounded field, so it is the one that gives.
 *
 * Returns how many were dropped so the receipt can say so rather than quietly appearing
 * complete. Throws if it cannot fit even with no sources at all, because publishing a
 * chunked receipt is worse than failing loudly.
 */
export function fitReceipt(receipt: Receipt): { receipt: Receipt; droppedSources: number } {
  if (fitsOneChunk(receipt)) return { receipt, droppedSources: 0 };

  const sources = [...receipt.sources];
  let dropped = 0;

  while (sources.length > 0) {
    sources.pop();
    dropped++;
    const trimmed = { ...receipt, sources };
    if (fitsOneChunk(trimmed)) return { receipt: trimmed, droppedSources: dropped };
  }

  const bare = { ...receipt, sources: [] };
  if (fitsOneChunk(bare)) return { receipt: bare, droppedSources: dropped };

  throw new Error(
    `receipt for job ${receipt.jobId} is ${new TextEncoder().encode(canonical(bare)).length} bytes with no sources and cannot fit one ${HCS_CHUNK_BYTES}-byte chunk`,
  );
}

/**
 * Decode base64 to a UTF-8 string in either runtime.
 *
 * `atob` alone mangles multi-byte characters — it yields one char per byte — so the
 * bytes are rebuilt and decoded properly. A receipt with an accented author name would
 * otherwise hash differently in the browser than in the CLI.
 */
function decodeBase64Utf8(b64: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
