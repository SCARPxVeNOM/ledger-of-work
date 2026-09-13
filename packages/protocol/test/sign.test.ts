import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { signReceipt, signingBytes, verifySignature } from "../src/sign.js";
import { makeReceipt } from "./fixtures.js";

/**
 * Binding a receipt to whoever asserted it.
 *
 * Real ed25519, not a stub. A fake signer would let every test here pass against an
 * implementation that signed the wrong bytes — which is the single thing these tests
 * exist to catch, because signing the wrong bytes produces a receipt that verifies for
 * the seller and for nobody else.
 */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const sign = (bytes: string) =>
  nodeSign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64url");
const verify = (bytes: string, sig: string) =>
  nodeVerify(null, Buffer.from(bytes, "utf8"), publicKey, Buffer.from(sig, "base64url"));

const IDENTITY = "uaid:aid:abc;uid=0;registry=x;proto=a2a;nativeId=hedera:testnet:0.0.1";

describe("signing a receipt", () => {
  it("signs bytes that do not include the signature itself", () => {
    // Otherwise verifying would need the receipt as it looked before signing, which
    // nobody reading it off the topic can reconstruct.
    const receipt = makeReceipt();
    const before = signingBytes(receipt);
    const signed = signReceipt(receipt, { alg: "ed25519", by: IDENTITY, sign });

    expect(signingBytes(signed)).toBe(before);
  });

  it("verifies with the key that signed it", () => {
    const signed = signReceipt(makeReceipt(), { alg: "ed25519", by: IDENTITY, sign });

    expect(verifySignature(signed, verify)).toBe(true);
  });

  it("fails when one field of the receipt changed", () => {
    const signed = signReceipt(makeReceipt(), { alg: "ed25519", by: IDENTITY, sign });
    const tampered = { ...signed, price: { ...signed.price, charged: "1" } };

    expect(verifySignature(tampered, verify)).toBe(false);
  });

  it("fails against a different key", () => {
    const other = generateKeyPairSync("ed25519");
    const signed = signReceipt(makeReceipt(), { alg: "ed25519", by: IDENTITY, sign });
    const wrong = (bytes: string, sig: string) =>
      nodeVerify(null, Buffer.from(bytes, "utf8"), other.publicKey, Buffer.from(sig, "base64url"));

    expect(verifySignature(signed, wrong)).toBe(false);
  });

  it("reports an unsigned receipt as unsigned rather than throwing", () => {
    expect(verifySignature(makeReceipt(), verify)).toBe(false);
  });

  it("treats a malformed signature as unverified, not as a crash", () => {
    const signed = signReceipt(makeReceipt(), { alg: "ed25519", by: IDENTITY, sign });
    const garbage = { ...signed, sig: { ...signed.sig!, sig: "not base64url ¬" } };

    expect(verifySignature(garbage, verify)).toBe(false);
  });

  it("records who signed it and how", () => {
    const signed = signReceipt(makeReceipt(), { alg: "ed25519", by: IDENTITY, sign });

    expect(signed.sig?.by).toBe(IDENTITY);
    expect(signed.sig?.alg).toBe("ed25519");
  });

  it("does not disturb the rest of the receipt", () => {
    // A signature is added to a receipt; it does not get to edit one.
    const receipt = makeReceipt();
    const { sig: _added, ...rest } = signReceipt(receipt, { alg: "ed25519", by: IDENTITY, sign });

    expect(rest).toEqual(receipt);
  });

  it("signs the same receipt to the same bytes whatever the key order", () => {
    // The bytes are canonical, so two sellers building the same receipt with their fields
    // in a different order must produce the same signing input or verification is a
    // coin flip.
    const receipt = makeReceipt();
    const reordered = Object.fromEntries(
      Object.entries(receipt).reverse(),
    ) as unknown as typeof receipt;

    expect(signingBytes(reordered)).toBe(signingBytes(receipt));
  });
});
