import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { hashCanonical, verifySignature } from "@low/protocol";
import { buildReceipt } from "../src/receipt.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const identity = {
  alg: "ed25519" as const,
  by: "uaid:aid:abc",
  sign: (bytes: string) =>
    nodeSign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64url"),
};
const verify = (bytes: string, sig: string) =>
  nodeVerify(null, Buffer.from(bytes, "utf8"), publicKey, Buffer.from(sig, "base64url"));

const config = {
  capability: "text.summarise",
  book: {
    base: "1000",
    perStep: "0",
    perPage: "0",
    perSecond: "0",
    ceiling: "1000000",
    per: { tokens: "5" },
  },
  price: () => ({ tokens: 200 }),
  evidence: (out: { text: string }) => ({ output: hashCanonical(out.text) }),
};

const args = {
  jobId: "job-1",
  units: { tokens: 200 },
  out: { text: "a summary" },
  amount: "2000",
  charged: "2000",
  payer: "0.0.123",
  payTo: "0.0.456",
  network: "hedera:testnet",
  asset: "0.0.0",
  startedAt: "2026-09-12T00:00:00.000Z",
  finishedAt: "2026-09-12T00:00:01.000Z",
  status: "ok" as const,
  identity,
};

describe("building a receipt from what happened", () => {
  it("signs it, and the signature verifies", () => {
    expect(verifySignature(buildReceipt(config, args), verify)).toBe(true);
  });

  it("records the units that were metered", () => {
    expect(buildReceipt(config, args).work).toEqual({ tokens: 200 });
  });

  it("commits to the answer itself, so the buyer's copy can be checked", () => {
    expect(buildReceipt(config, args).resultHash).toBe(hashCanonical(args.out));
  });

  it("commits to declared artifacts by hash, never by value", () => {
    const receipt = buildReceipt(config, args);

    expect(receipt.evidence?.output).toBe(hashCanonical("a summary"));
    // The whole point of hashing: the text is nowhere in what gets published.
    expect(JSON.stringify(receipt)).not.toContain("a summary");
  });

  it("is written at the current schema version", () => {
    expect(buildReceipt(config, args).v).toBe(4);
  });

  it("refuses to sign something that could not be published", () => {
    // Checking size after signing has only bad options: trimming invalidates the
    // signature, and not publishing leaves a paid job with no record. Checking first puts
    // the failure in the adopter's config, where it can be fixed.
    const fat = {
      ...config,
      evidence: () =>
        Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`art${i}`, "a".repeat(400)])),
    };

    expect(() => buildReceipt(fat, args)).toThrow(/1024/);
  });

  it("records a job that delivered nothing as failed and charged zero", () => {
    const receipt = buildReceipt(config, { ...args, charged: "0", status: "failed" });

    expect(receipt.status).toBe("failed");
    expect(receipt.price.charged).toBe("0");
    // The quote stays on the record: what it would have cost is part of the story.
    expect(receipt.price.quoted).toBe("2000");
  });

  it("prefers measured work over quoted work when the adopter measures it", () => {
    const measured = { ...config, work: () => ({ tokens: 173 }) };

    expect(buildReceipt(measured, args).work).toEqual({ tokens: 173 });
  });

  it("names the payer and the payee, so a settlement can be matched to it", () => {
    const receipt = buildReceipt(config, args);

    expect(receipt.payment.payer).toBe("0.0.123");
    expect(receipt.payment.payTo).toBe("0.0.456");
    expect(receipt.payment.scheme).toBe("exact");
  });
});
