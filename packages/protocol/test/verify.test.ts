import { describe, expect, it } from "vitest";
import { fitsOneChunk, verifyReceipt } from "../src/verify.js";
import { canonicalByteLength } from "../src/canonical.js";
import { HCS_CHUNK_BYTES } from "../src/types.js";
import {
  BUYER,
  EXPECTED_CHARGE,
  PRICE_BOOK,
  RESULT,
  SELLER,
  makeMessage,
  makeReceipt,
  makeTransaction,
} from "./fixtures.js";

function verifyFixture(over: {
  receipt?: Parameters<typeof makeReceipt>[0];
  result?: unknown;
  message?: Parameters<typeof makeMessage>[1];
  transaction?: Parameters<typeof makeTransaction>[1];
} = {}) {
  const receipt = makeReceipt(over.receipt);
  return verifyReceipt({
    result: "result" in over ? over.result : RESULT,
    message: makeMessage(receipt, over.message),
    transaction: makeTransaction(receipt, over.transaction),
    expectedSubmitter: SELLER,
    priceBook: PRICE_BOOK,
  });
}

const failedIds = (out: ReturnType<typeof verifyFixture>) =>
  out.checks.filter((c) => !c.ok).map((c) => c.id);

describe("verifyReceipt — the happy path", () => {
  it("passes every check on an untampered receipt", () => {
    const out = verifyFixture();
    expect(failedIds(out)).toEqual([]);
    expect(out.ok).toBe(true);
  });

  it("reports each claim separately so a failure is diagnosable", () => {
    const out = verifyFixture();
    expect(out.checks.map((c) => c.id)).toEqual([
      "message",
      "submitter",
      "parse",
      "result",
      "timing",
      "payment",
      "payer",
      "meter",
    ]);
  });
});

describe("verifyReceipt — a verifier that only ever passes is not evidence", () => {
  it("goes red when one byte of the result is changed", () => {
    const tampered = structuredClone(RESULT);
    tampered.items[0]!.author = "J.K. Rowlingg";
    const out = verifyFixture({ result: tampered });
    expect(out.ok).toBe(false);
    expect(failedIds(out)).toContain("result");
  });

  it("goes red when the result is reordered but the hash was taken over the original", () => {
    // Canonical encoding makes key order irrelevant, so this must still PASS —
    // reordering keys is not tampering.
    const reordered = { ...RESULT, items: RESULT.items.map((i) => ({ author: i.author, text: i.text })) };
    expect(verifyFixture({ result: reordered }).ok).toBe(true);

    // Reordering the *array* is a different result, and must fail.
    const swapped = { ...RESULT, items: [...RESULT.items].reverse() };
    expect(failedIds(verifyFixture({ result: swapped }))).toContain("result");
  });

  it("goes red when someone other than the service submitted the receipt", () => {
    const out = verifyFixture({ message: { payer_account_id: "0.0.999999" } });
    expect(failedIds(out)).toContain("submitter");
  });

  it("goes red when the receipt claims a price its recorded work does not support", () => {
    const out = verifyFixture({
      receipt: { price: { unit: "tinybar", quoted: EXPECTED_CHARGE, charged: "900000" } },
    });
    expect(failedIds(out)).toContain("meter");
  });

  it("goes red when the on-chain amount differs from the charge claimed", () => {
    const out = verifyFixture({
      transaction: {
        transfers: [
          { account: BUYER, amount: -1, is_approval: false },
          { account: SELLER, amount: 1, is_approval: false },
        ],
      },
    });
    expect(failedIds(out)).toContain("payment");
  });

  it("goes red when the settlement transaction did not succeed", () => {
    const out = verifyFixture({ transaction: { result: "INSUFFICIENT_PAYER_BALANCE" } });
    expect(failedIds(out)).toContain("payment");
  });

  it("goes red when the named paying agent never sent anything", () => {
    // The subtle forgery: payment settled, amount correct, but the receipt credits the
    // job to an account that was not involved. The transaction must be pinned to the
    // *real* buyer independently of the receipt, or the fixture would forge both sides
    // in agreement and the check would pass vacuously.
    const forged = makeReceipt({ payment: { ...makeReceipt().payment, payer: "0.0.4242" } });
    const out = verifyReceipt({
      result: RESULT,
      message: makeMessage(forged),
      transaction: makeTransaction(makeReceipt()), // real buyer, real amount
      expectedSubmitter: SELLER,
      priceBook: PRICE_BOOK,
    });
    expect(out.ok).toBe(false);
    expect(failedIds(out)).toContain("payer");
    // Everything else about the payment still checks out — which is what makes this
    // forgery worth testing for.
    expect(failedIds(out)).not.toContain("payment");
  });

  it("goes red when consensus predates the claimed finish time", () => {
    const receipt = makeReceipt();
    const early = Date.parse(receipt.startedAt) - 60_000;
    const out = verifyFixture({
      message: { consensus_timestamp: `${Math.floor(early / 1000)}.000000000` },
    });
    expect(failedIds(out)).toContain("timing");
  });

  it("goes red when consensus is implausibly long after the job", () => {
    const receipt = makeReceipt();
    const late = Date.parse(receipt.finishedAt) + 48 * 3600_000;
    const out = verifyFixture({
      message: { consensus_timestamp: `${Math.floor(late / 1000)}.000000000` },
    });
    expect(failedIds(out)).toContain("timing");
  });

  it("stops early and does not pretend to verify an unparseable payload", () => {
    const receipt = makeReceipt();
    const out = verifyReceipt({
      result: RESULT,
      message: makeMessage(receipt, { message: Buffer.from("not json").toString("base64") }),
      expectedSubmitter: SELLER,
      priceBook: PRICE_BOOK,
    });
    expect(out.ok).toBe(false);
    expect(failedIds(out)).toContain("parse");
    expect(out.checks.some((c) => c.id === "result")).toBe(false);
  });

  it("refuses a schema version it does not understand rather than guessing", () => {
    const out = verifyFixture({ receipt: { v: 99 as unknown as 1 } });
    expect(out.ok).toBe(false);
    expect(failedIds(out)).toContain("parse");
  });

  it("flags a chunked message instead of silently verifying a fragment", () => {
    const out = verifyFixture({ message: { chunk_info: { number: 1, total: 3 } } });
    expect(out.ok).toBe(false);
    expect(failedIds(out)).toContain("message");
  });

  it("does not claim the payment is verified when no transaction was supplied", () => {
    const receipt = makeReceipt();
    const out = verifyReceipt({
      result: RESULT,
      message: makeMessage(receipt),
      expectedSubmitter: SELLER,
      priceBook: PRICE_BOOK,
    });
    expect(failedIds(out)).toContain("payment");
  });

  it("does not claim the meter is verified when no price book was supplied", () => {
    const receipt = makeReceipt();
    const out = verifyReceipt({
      result: RESULT,
      message: makeMessage(receipt),
      transaction: makeTransaction(receipt),
      expectedSubmitter: SELLER,
    });
    expect(failedIds(out)).toContain("meter");
  });
});

describe("receipt size", () => {
  it("fits in a single HCS chunk, so the REST reader never has to reassemble", () => {
    const receipt = makeReceipt();
    expect(canonicalByteLength(receipt)).toBeLessThanOrEqual(HCS_CHUNK_BYTES);
    expect(fitsOneChunk(receipt)).toBe(true);
  });

  it("detects a receipt that has outgrown one chunk", () => {
    const bloated = makeReceipt({ sources: Array.from({ length: 40 }, (_, i) => `https://example.com/a-fairly-long-source-url/${i}`) });
    expect(fitsOneChunk(bloated)).toBe(false);
  });
});
