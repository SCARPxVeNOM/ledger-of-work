import { hashCanonical } from "../src/hash.js";
import type { MirrorTopicMessage, MirrorTransaction } from "../src/verify.js";
import type { PriceBook, Receipt } from "../src/types.js";

export const SELLER = "0.0.8011510";
export const BUYER = "0.0.7326075";
/** Blocky402's Hedera fee payer, read from GET /supported on testnet. */
export const FEE_PAYER = "0.0.7162784";

export const PRICE_BOOK: PriceBook = {
  base: "50000",
  perStep: "10000",
  perPage: "25000",
  perSecond: "2000",
  ceiling: "2000000",
};

/** The result the buyer holds. */
export const RESULT = {
  capability: "quotes.search_and_extract",
  query: { tag: "love", max: 3 },
  items: [
    { text: "It is our choices, Harry.", author: "J.K. Rowling" },
    { text: "There are only two ways to live your life.", author: "Albert Einstein" },
  ],
};

const WORK = { steps: 7, pages: 2, sessionMs: 6768 };
/** What the quote was priced from. Reality came in one step over — absorbed by the seller. */
const PLAN = { steps: 6, pages: 2, estimatedMs: 6000 };

/** plan: base 50000 + 6*10000 + 2*25000 + 6s*2000 => 50000+60000+50000+12000 */
export const EXPECTED_CHARGE = "172000";

export const EVIDENCE = {
  pageHash: `sha256:${"ab".repeat(32)}`,
  screenshotHash: `sha256:${"cd".repeat(32)}`,
  finalUrl: "https://quotes.toscrape.com/tag/love/page/2/",
  capturedAt: "2026-09-08T04:12:09.900Z",
};

/** A retrieval commitment the size a real one is — see packages/proof for the genuine article. */
export const RETRIEVAL = { proofHash: `sha256:${"ef".repeat(32)}` };

export function makeReceipt(
  overrides: Partial<Record<keyof Receipt, unknown>> = {},
): Receipt {
  return {
    v: 2,
    kind: "delivery",
    // A UUID, because that is what the seller actually generates — 10 bytes longer than
    // a ULID, and the byte-budget test is worthless if the fixture is the cheap case.
    jobId: "47f7f63d-4c1d-4b69-9419-6c7ae90e8ef4",
    capability: "quotes.search_and_extract",
    resultHash: hashCanonical(RESULT),
    sources: ["https://quotes.toscrape.com/tag/love/", "https://quotes.toscrape.com/tag/love/page/2/"],
    startedAt: "2026-09-08T04:12:03.114Z",
    finishedAt: "2026-09-08T04:12:09.882Z",
    plan: PLAN,
    work: WORK,
    price: { unit: "tinybar", quoted: EXPECTED_CHARGE, charged: EXPECTED_CHARGE },
    evidence: EVIDENCE,
    payment: {
      network: "hedera:testnet",
      scheme: "exact",
      asset: "0.0.0",
      txId: `${FEE_PAYER}@1757304723.987654321`,
      payer: BUYER,
      payTo: SELLER,
    },
    status: "ok",
    ...overrides,
  } as Receipt;
}

export function makeMessage(
  receipt: Receipt,
  overrides: Partial<MirrorTopicMessage> = {},
): MirrorTopicMessage {
  // Consensus lands a couple of seconds after the job finished, as it does in practice.
  const consensusMs = Date.parse(receipt.finishedAt) + 2_400;
  return {
    consensus_timestamp: `${Math.floor(consensusMs / 1000)}.${String((consensusMs % 1000) * 1_000_000).padStart(9, "0")}`,
    message: Buffer.from(JSON.stringify(receipt), "utf8").toString("base64"),
    payer_account_id: SELLER,
    running_hash: "LXM6fJJ/d7ECRLEa05e3Sjk1qrAYooJhQkzGuB0rWXz7l5PSKO5mamPKbYFZ6VAU",
    running_hash_version: 3,
    sequence_number: 42,
    topic_id: "0.0.12345",
    chunk_info: { number: 1, total: 1 },
    ...overrides,
  };
}

export function makeTransaction(
  receipt: Receipt,
  overrides: Partial<MirrorTransaction> = {},
): MirrorTransaction {
  const charged = Number(receipt.price.charged);
  return {
    transaction_id: "0.0.7162784-1757304723-987654321",
    result: "SUCCESS",
    consensus_timestamp: "1757304725.123456789",
    transfers: [
      // The transfer body the buyer constructs moves exactly `charged` from buyer to
      // seller and nets to zero — that is what the facilitator's safety checks inspect.
      { account: receipt.payment.payer, amount: -charged, is_approval: false },
      { account: receipt.payment.payTo, amount: charged, is_approval: false },
      // The network then adds its own fee transfers to the *record*: the fee payer is
      // debited the network fee it agreed to sponsor. These are not part of the body the
      // facilitator validates, so they do not violate the "fee payer is not a net sender
      // of the payment" rule.
      { account: FEE_PAYER, amount: -118_000, is_approval: false },
      { account: "0.0.98", amount: 118_000, is_approval: false },
    ],
    ...overrides,
  };
}
