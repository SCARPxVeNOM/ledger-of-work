import { describe, expect, it } from "vitest";
import { fitReceipt, fitsOneChunk, verifyReceipt } from "../src/verify.js";
import { canonicalByteLength } from "../src/canonical.js";
import { hashCanonical } from "../src/hash.js";
import { HCS_CHUNK_BYTES, type Receipt } from "../src/types.js";
import {
  BUYER,
  EVIDENCE,
  EXPECTED_CHARGE,
  PRICE_BOOK,
  RESULT,
  SELLER,
  makeMessage,
  makeReceipt,
  makeTransaction,
  RETRIEVAL,
} from "./fixtures.js";

function verifyFixture(over: {
  receipt?: Parameters<typeof makeReceipt>[0];
  result?: unknown;
  message?: Parameters<typeof makeMessage>[1];
  transaction?: Parameters<typeof makeTransaction>[1];
} = {}) {
  const receipt = makeReceipt(over.receipt);
  return verifyReceipt({
    resultHash: hashCanonical("result" in over ? over.result : RESULT),
    pageHash: EVIDENCE.pageHash,
    screenshotHash: EVIDENCE.screenshotHash,
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
      "page",
      "screenshot",
      "timing",
      "payment",
      "payer",
      "meter",
      "charge",
      "variance",
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

  it("goes red when the quote does not follow the published price book", () => {
    const out = verifyFixture({
      receipt: { price: { unit: "tinybar", quoted: "900000", charged: "900000" } },
    });
    expect(failedIds(out)).toContain("meter");
  });

  it("goes red when the buyer was charged more than they were quoted", () => {
    const out = verifyFixture({
      receipt: { price: { unit: "tinybar", quoted: EXPECTED_CHARGE, charged: "900000" } },
    });
    expect(failedIds(out)).toContain("charge");
  });

  it("does not penalise a job whose real work diverged from the plan", () => {
    // The plan said 6 steps, the work took 7. On `exact` the buyer still pays the quote
    // and the seller absorbs the rest — that is not a verification failure.
    const out = verifyFixture();
    expect(out.ok).toBe(true);
    const variance = out.checks.find((c) => c.id === "variance");
    expect(variance?.detail).toMatch(/absorbed by the seller/);
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
      resultHash: hashCanonical(RESULT),
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
      resultHash: hashCanonical(RESULT),
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
      resultHash: hashCanonical(RESULT),
      message: makeMessage(receipt),
      expectedSubmitter: SELLER,
      priceBook: PRICE_BOOK,
    });
    expect(failedIds(out)).toContain("payment");
  });

  it("does not claim the meter is verified when no price book was supplied", () => {
    const receipt = makeReceipt();
    const out = verifyReceipt({
      resultHash: hashCanonical(RESULT),
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

describe("evidence, and receipts written before it existed", () => {
  it("goes red when the page HTML does not match", () => {
    const out = verifyReceipt({
      resultHash: hashCanonical(RESULT),
      pageHash: `sha256:${"99".repeat(32)}`,
      screenshotHash: EVIDENCE.screenshotHash,
      message: makeMessage(makeReceipt()),
      transaction: makeTransaction(makeReceipt()),
      expectedSubmitter: SELLER,
      priceBook: PRICE_BOOK,
    });
    expect(out.ok).toBe(false);
    expect(out.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["page"]);
  });

  it("goes red when the screenshot does not match, even if the HTML does", () => {
    // The screenshot is the artifact a human can actually look at, so it has to be
    // checked independently rather than folded into one evidence verdict.
    const out = verifyReceipt({
      resultHash: hashCanonical(RESULT),
      pageHash: EVIDENCE.pageHash,
      screenshotHash: `sha256:${"11".repeat(32)}`,
      message: makeMessage(makeReceipt()),
      transaction: makeTransaction(makeReceipt()),
      expectedSubmitter: SELLER,
      priceBook: PRICE_BOOK,
    });
    expect(out.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["screenshot"]);
  });

  it("reports unproven — not passing — when the buyer kept no artifacts", () => {
    // A check that silently succeeds on missing input is worse than no check.
    const out = verifyReceipt({
      resultHash: hashCanonical(RESULT),
      message: makeMessage(makeReceipt()),
      transaction: makeTransaction(makeReceipt()),
      expectedSubmitter: SELLER,
      priceBook: PRICE_BOOK,
    });
    const page = out.checks.find((c) => c.id === "page");
    expect(page?.ok).toBe(false);
    expect(page?.detail).toMatch(/not checked/);
  });

  it("still verifies a v1 receipt, which predates evidence entirely", () => {
    // Receipts 1-15 on the live topic are v1. A schema change that orphaned them would
    // put a hole in the one log the product's claim rests on.
    const { evidence: _dropped, ...rest } = makeReceipt();
    const v1 = { ...rest, v: 1 } as Receipt;
    const out = verifyReceipt({
      resultHash: hashCanonical(RESULT),
      message: makeMessage(v1),
      transaction: makeTransaction(v1),
      expectedSubmitter: SELLER,
      priceBook: PRICE_BOOK,
    });
    expect(out.ok).toBe(true);
    // And it does not invent evidence checks for a receipt that never carried any.
    expect(out.checks.some((c) => c.id === "page")).toBe(false);
  });
});

describe("fitting a receipt into one chunk", () => {
  it("leaves a receipt alone when it already fits", () => {
    const r = makeReceipt();
    const { receipt, droppedSources } = fitReceipt(r);
    expect(droppedSources).toBe(0);
    expect(receipt.sources).toEqual(r.sources);
  });

  it("drops sources until it fits, and says how many", () => {
    const bloated = makeReceipt({
      sources: Array.from({ length: 12 }, (_, i) => `https://example.com/a-long-source-url/${i}`),
    });
    expect(fitsOneChunk(bloated)).toBe(false);
    const { receipt, droppedSources } = fitReceipt(bloated);
    expect(fitsOneChunk(receipt)).toBe(true);
    expect(droppedSources).toBeGreaterThan(0);
    expect(receipt.sources.length).toBe(12 - droppedSources);
  });

  it("drops the newest sources first, keeping the earliest", () => {
    const bloated = makeReceipt({
      sources: Array.from({ length: 12 }, (_, i) => `https://example.com/a-long-source-url/${i}`),
    });
    const { receipt } = fitReceipt(bloated);
    expect(receipt.sources[0]).toBe("https://example.com/a-long-source-url/0");
  });

  it("throws rather than publishing a chunked receipt it cannot shrink", () => {
    const impossible = makeReceipt({ capability: "x".repeat(1200), sources: [] });
    expect(() => fitReceipt(impossible)).toThrow(/cannot fit one/);
  });
});

describe("retrieval proofs — the only check the seller cannot manufacture", () => {
  // v3 evidence carries no `capturedAt` — see the type. The seller stopped writing it
  // when the retrieval commitment arrived and the byte budget ran out.
  const v3 = (over: Partial<Parameters<typeof makeReceipt>[0]> = {}) =>
    makeReceipt({
      v: 3,
      retrieval: RETRIEVAL,
      evidence: { ...EVIDENCE, capturedAt: undefined },
      ...over,
    });

  const run = (
    receipt: ReturnType<typeof makeReceipt>,
    extra: { retrievalProofHash?: string; retrievalCoverage?: { ok: boolean; detail: string } } = {},
  ) =>
    verifyReceipt({
      resultHash: hashCanonical(RESULT),
      pageHash: EVIDENCE.pageHash,
      screenshotHash: EVIDENCE.screenshotHash,
      message: makeMessage(receipt),
      transaction: makeTransaction(receipt),
      expectedSubmitter: SELLER,
      priceBook: PRICE_BOOK,
      ...extra,
    });

  const check = (out: ReturnType<typeof run>, id: string) => out.checks.find((c) => c.id === id);

  it("passes when the buyer's proof is the one committed to and it covers the answer", () => {
    const out = run(v3(), {
      retrievalProofHash: RETRIEVAL.proofHash,
      retrievalCoverage: { ok: true, detail: "witnessed" },
    });
    expect(check(out, "retrieval-hash")?.ok).toBe(true);
    expect(check(out, "retrieval-coverage")?.ok).toBe(true);
    expect(out.ok).toBe(true);
  });

  it("fails when a different proof is presented", () => {
    const out = run(v3(), {
      retrievalProofHash: `sha256:${"00".repeat(32)}`,
      retrievalCoverage: { ok: true, detail: "witnessed" },
    });
    expect(check(out, "retrieval-hash")?.ok).toBe(false);
    expect(out.ok).toBe(false);
  });

  it("fails when the proof is genuine but does not cover the answer", () => {
    // The subtle attack: witness a real page, deliver something it does not say.
    const out = run(v3(), {
      retrievalProofHash: RETRIEVAL.proofHash,
      retrievalCoverage: { ok: false, detail: "not in the delivered answer" },
    });
    expect(check(out, "retrieval-coverage")?.ok).toBe(false);
    expect(out.ok).toBe(false);
  });

  it("reports unproven, not fine, when the buyer supplies no proof", () => {
    const out = run(v3());
    expect(check(out, "retrieval-hash")?.ok).toBe(false);
    expect(check(out, "retrieval-hash")?.detail).toContain("not checked");
    expect(check(out, "retrieval-coverage")?.detail).toContain("not checked");
  });

  it("says so when a v3 receipt carries no proof at all", () => {
    const out = run(makeReceipt({ v: 3 }));
    expect(check(out, "retrieval-hash")?.ok).toBe(false);
    expect(check(out, "retrieval-hash")?.detail).toContain("only as good as the seller's word");
    expect(check(out, "retrieval-coverage")).toBeUndefined();
  });

  it("does not invent retrieval checks for older receipts", () => {
    // v1 and v2 receipts predate proofs entirely. Failing them for lacking a field that
    // did not exist would be a verifier that rejects its own history.
    for (const v of [1, 2]) {
      const out = run(makeReceipt({ v, ...(v === 1 ? { evidence: undefined } : {}) }));
      expect(check(out, "retrieval-hash"), `v${v} invented a retrieval check`).toBeUndefined();
    }
  });

  it("fits one HCS chunk with evidence and a retrieval commitment together", () => {
    expect(fitsOneChunk(v3({ sources: [] }))).toBe(true);
  });

  it("has almost no headroom left, and this test is the alarm", () => {
    // 1024 bytes is the hard limit — a receipt over it is split into chunks, and the
    // mirror REST API does not reassemble them, so it becomes unverifiable by the very
    // people it exists for. A v3 receipt with both commitments spends nearly all of it.
    //
    // If this number moves, a field was added. That is allowed, but it costs sources:
    // decide deliberately rather than discovering it when a receipt fails to publish.
    const bytes = canonicalByteLength(v3({ sources: [] }));
    expect(bytes).toBeLessThanOrEqual(HCS_CHUNK_BYTES);
    // ~969 today. Room for roughly one source URL and nothing else.
    expect(HCS_CHUNK_BYTES - bytes).toBeLessThan(120);
  });

  it("sheds sources rather than overflowing when a v3 job touched many pages", () => {
    const bloated = v3({
      sources: Array.from({ length: 10 }, (_, i) => `https://www.whitehouse.gov/presidential-actions/page/${i}/`),
    });
    const { receipt, droppedSources } = fitReceipt(bloated);
    expect(fitsOneChunk(receipt)).toBe(true);
    expect(droppedSources).toBeGreaterThan(0);
  });
});
