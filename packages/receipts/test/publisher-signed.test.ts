import { describe, expect, it } from "vitest";
import { fitReceipt, signingBytes, type Receipt } from "@low/protocol";
import { assertNotTrimmedAfterSigning, SignedReceiptTooLarge } from "../src/publisher.js";

/**
 * The one way this design fails silently.
 *
 * `publish` trims a receipt that will not fit one HCS chunk, dropping source URLs until it
 * does. That is the right trade for an unsigned receipt — losing a source beats failing a
 * job the buyer has already paid for.
 *
 * For a signed receipt it is the opposite, and quietly so. The signature covers the
 * untrimmed bytes, so a trimmed receipt lands on the topic and then fails verification for
 * everyone who reads it — on oversized receipts only, which are the rare ones nobody
 * tests, and long after the buyer has gone.
 */

/** A minimal valid receipt, built here: this package has no shared fixture. */
const makeReceipt = (over: Partial<Receipt> = {}): Receipt =>
  ({
    v: 4,
    kind: "delivery",
    jobId: "job-1",
    capability: "text.wordcount",
    resultHash: "sha256:aa",
    sources: [],
    startedAt: "2026-09-12T00:00:00.000Z",
    finishedAt: "2026-09-12T00:00:01.000Z",
    plan: { steps: 0, pages: 0, estimatedMs: 0 },
    work: { tokens: 5 },
    price: { unit: "tinybar", quoted: "1025", charged: "1025" },
    payment: {
      network: "hedera:testnet",
      scheme: "exact",
      asset: "0.0.0",
      payer: "0.0.1",
      payTo: "0.0.2",
    },
    status: "ok",
    ...over,
  }) as Receipt;

const manySources = Array.from(
  { length: 40 },
  (_, i) => `https://example.com/a-fairly-long-path/${i}`,
);
const SIG = { alg: "ed25519" as const, by: "uaid:aid:abc", sig: "zzz" };

describe("trimming and signatures", () => {
  it("changes the bytes a signature covers, which is why it must not happen after signing", () => {
    const receipt = makeReceipt({ sources: manySources, sig: SIG });
    const { receipt: trimmed, droppedSources } = fitReceipt(receipt);

    expect(droppedSources).toBeGreaterThan(0);
    // The hazard, demonstrated: same receipt, different signing input.
    expect(signingBytes(trimmed)).not.toBe(signingBytes(receipt));
  });
});

describe("publishing a signed receipt", () => {
  it("refuses an oversized signed receipt rather than trimming it", () => {
    expect(() =>
      assertNotTrimmedAfterSigning(makeReceipt({ sources: manySources, sig: SIG })),
    ).toThrow(SignedReceiptTooLarge);
  });

  it("explains that the signer must shrink it before signing", () => {
    expect(() =>
      assertNotTrimmedAfterSigning(makeReceipt({ sources: manySources, sig: SIG })),
    ).toThrow(/before signing/);
  });

  it("says nothing about a signed receipt that already fits", () => {
    expect(() => assertNotTrimmedAfterSigning(makeReceipt({ sig: SIG }))).not.toThrow();
  });

  it("says nothing about an unsigned receipt, which may still be trimmed", () => {
    // Every receipt already on the topic. Trimming those is still the right behaviour.
    expect(() => assertNotTrimmedAfterSigning(makeReceipt({ sources: manySources }))).not.toThrow();
  });
});
