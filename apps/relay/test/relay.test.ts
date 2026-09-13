import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { signReceipt, type PriceBook, type Receipt } from "@low/protocol";
import { Relay } from "../src/relay.js";

/**
 * Every check in the relay defends our wallet, not the buyer's trust.
 *
 * The buyer verifies independently against a public topic and needs nothing from us — and
 * that is precisely what makes this component acceptable to exist. If it were load-bearing
 * for the buyer, it would be the middleman the project exists to remove.
 */

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const IDENTITY = "uaid:aid:abc";

/** A minimal valid receipt, built here rather than imported across a package boundary. */
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

const signed = (over: Partial<Receipt> = {}) =>
  signReceipt(makeReceipt(over), {
    alg: "ed25519",
    by: IDENTITY,
    sign: (b) => nodeSign(null, Buffer.from(b, "utf8"), privateKey).toString("base64url"),
  });

function relay(over: Partial<ConstructorParameters<typeof Relay>[0]> = {}) {
  const submit = vi.fn(async () => ({ topicId: "0.0.777", sequenceNumber: 1 }));
  const instance = new Relay({
    submit,
    resolve: async () => ({ topic: "0.0.777", publicKey: "x", book: {} as PriceBook }),
    verify: (bytes, sig) =>
      nodeVerify(null, Buffer.from(bytes, "utf8"), publicKey, Buffer.from(sig, "base64url")),
    quotaPerIdentity: 10,
    ...over,
  });
  return { relay: instance, submit };
}

describe("accepting a receipt", () => {
  it("submits one signed by a listed identity", async () => {
    const { relay: r, submit } = relay();

    expect(await r.accept(signed())).toEqual({ ok: true, topic: "0.0.777" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("refuses an unsigned receipt", async () => {
    const { relay: r, submit } = relay();

    expect(await r.accept(makeReceipt())).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a receipt whose signature does not verify", async () => {
    // We pay the fee, so we check before spending it. The buyer checks again afterwards.
    const { relay: r, submit } = relay({ verify: () => false });

    expect(await r.accept(signed())).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses an identity nobody listed", async () => {
    const { relay: r, submit } = relay({ resolve: async () => null });

    expect(await r.accept(signed())).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits a repeated jobId only once", async () => {
    // A cost defence rather than a correctness one: the receipt would be identical either
    // way, but the second submission spends our HBAR for nothing.
    const { relay: r, submit } = relay();
    const receipt = signed();

    await r.accept(receipt);

    expect(await r.accept(receipt)).toMatchObject({ ok: false });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("stops an identity that exceeds its quota", async () => {
    // Every submission spends our HBAR, so an adopter — or whoever holds their key — can
    // otherwise drain the relay.
    const { relay: r, submit } = relay({ quotaPerIdentity: 2 });

    for (let i = 0; i < 4; i++) await r.accept(signed({ jobId: `job-${i}` }));

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("refuses a receipt too large to publish, rather than trimming it", async () => {
    const { relay: r, submit } = relay();
    const fat = signed({
      sources: Array.from({ length: 40 }, (_, i) => `https://example.com/a-long-path/${i}`),
    });

    expect(await r.accept(fat)).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits to the topic the directory names, not one the receipt asks for", async () => {
    // A receipt naming its own destination would let a signer write into somebody else's
    // ledger. The directory is the authority on where an identity publishes.
    const { relay: r, submit } = relay({
      resolve: async () => ({ topic: "0.0.555", publicKey: "x", book: {} as PriceBook }),
    });

    await r.accept(signed());

    expect(submit).toHaveBeenCalledWith("0.0.555", expect.anything());
  });

  it("says why it refused, in terms the adopter can act on", async () => {
    const { relay: r } = relay({ resolve: async () => null });
    const out = await r.accept(signed());

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain(IDENTITY);
    expect(out.error).toMatch(/directory/);
  });
});
