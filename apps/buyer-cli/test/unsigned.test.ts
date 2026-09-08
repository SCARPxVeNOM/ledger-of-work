import { describe, expect, it } from "vitest";
import { AccountId, PrivateKey, Transaction } from "@hiero-ledger/sdk";
import type { PaymentRequirements } from "../src/pay.js";
import { TESTNET_NODE_ACCOUNTS, buildUnsignedPayment, payloadFromSignedBytes } from "../src/unsigned.js";

/**
 * These cover the half of wallet signing that does not need a wallet.
 *
 * The transaction construction is where the scheme's sharpest rule lives — the
 * transaction id must belong to the facilitator, not the buyer — and getting it wrong
 * produces an opaque InvalidSignature from the facilitator. That part is fully testable,
 * so it is tested; only the wallet round-trip is not.
 */

const FEE_PAYER = "0.0.7162784";
const BUYER = "0.0.10410543";
const SELLER = "0.0.10410493";

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "hedera:testnet",
  amount: "312000",
  payTo: SELLER,
  maxTimeoutSeconds: 300,
  asset: "0.0.0",
  extra: { feePayer: FEE_PAYER },
  ...over,
});

describe("buildUnsignedPayment", () => {
  it("gives the transaction id to the fee payer, not the buyer", () => {
    // The single most consequential rule in the Hedera exact scheme.
    const { transactionId } = buildUnsignedPayment(requirements(), BUYER);
    expect(transactionId.startsWith(`${FEE_PAYER}@`)).toBe(true);
    expect(transactionId.startsWith(BUYER)).toBe(false);
  });

  it("produces bytes a wallet can decode", () => {
    const { bytes } = buildUnsignedPayment(requirements(), BUYER);
    const decoded = Transaction.fromBytes(bytes);
    expect(decoded.transactionId?.accountId?.toString()).toBe(FEE_PAYER);
  });

  // The SDK's public `hbarTransfers` / `tokenTransfers` accessors are minified wrappers
  // whose shape differs between builds, so these read the underlying arrays. Reaching
  // for internals in a test is a real cost, taken because the alternative — asserting
  // nothing about the amounts — would leave the most consequential thing here unchecked.
  const hbarTransfers = (bytes: Uint8Array) =>
    (Transaction.fromBytes(bytes) as unknown as {
      _hbarTransfers: { accountId: AccountId; amount: { toTinybars(): { toString(): string } } }[];
    })._hbarTransfers.map((t) => [t.accountId.toString(), t.amount.toTinybars().toString()]);

  const tokenTransfers = (bytes: Uint8Array) =>
    (Transaction.fromBytes(bytes) as unknown as {
      _tokenTransfers: { tokenId: { toString(): string }; accountId: AccountId; amount: unknown }[];
    })._tokenTransfers.map((t) => [t.tokenId.toString(), t.accountId.toString(), String(t.amount)]);

  it("moves the exact amount from buyer to seller in HBAR", () => {
    const { bytes } = buildUnsignedPayment(requirements(), BUYER);
    expect(hbarTransfers(bytes)).toEqual(
      expect.arrayContaining([
        [BUYER, "-312000"],
        [SELLER, "312000"],
      ]),
    );
  });

  it("nets to zero, which the facilitator checks before it will settle", () => {
    const total = hbarTransfers(buildUnsignedPayment(requirements(), BUYER).bytes).reduce(
      (sum, [, amount]) => sum + BigInt(amount as string),
      0n,
    );
    expect(total).toBe(0n);
  });

  it("moves token units, and no HBAR, when the asset is an HTS token", () => {
    const { bytes } = buildUnsignedPayment(
      requirements({ asset: "0.0.10416991", amount: "312" }),
      BUYER,
    );
    expect(tokenTransfers(bytes)).toEqual(
      expect.arrayContaining([
        ["0.0.10416991", BUYER, "-312"],
        ["0.0.10416991", SELLER, "312"],
      ]),
    );
    // A token payment must not quietly move HBAR as well.
    expect(hbarTransfers(bytes)).toEqual([]);
  });

  it("freezes against nodes, since an unfrozen transaction cannot be signed", () => {
    const { bytes } = buildUnsignedPayment(requirements(), BUYER);
    const decoded = Transaction.fromBytes(bytes);
    expect(decoded.nodeAccountIds?.length).toBeGreaterThan(0);
    expect(TESTNET_NODE_ACCOUNTS).toContain(decoded.nodeAccountIds?.[0]?.toString());
  });

  it("refuses requirements with no fee payer rather than building an unpayable transaction", () => {
    const bad = { ...requirements(), extra: {} } as unknown as PaymentRequirements;
    expect(() => buildUnsignedPayment(bad, BUYER)).toThrow(/feePayer/);
  });

  it("refuses a non-integer amount before a wallet is ever prompted", () => {
    // A wallet prompt is the last place to surface an amount this code was unsure about.
    expect(() => buildUnsignedPayment(requirements({ amount: "1.5" }), BUYER)).toThrow(/integer/);
    expect(() => buildUnsignedPayment(requirements({ amount: "abc" }), BUYER)).toThrow(/integer/);
  });
});

describe("payloadFromSignedBytes", () => {
  it("wraps signed bytes into a decodable x402 payload", async () => {
    const { bytes } = buildUnsignedPayment(requirements(), BUYER);
    const key = PrivateKey.generateECDSA();
    const signed = await Transaction.fromBytes(bytes).sign(key);

    const header = payloadFromSignedBytes(requirements(), signed.toBytes());
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));

    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("hedera:testnet");
    expect(decoded.accepted.amount).toBe("312000");
    expect(typeof decoded.payload.transaction).toBe("string");
    // The wire payload must be the transaction bytes, not the outer JSON.
    expect(Transaction.fromBytes(Buffer.from(decoded.payload.transaction, "base64"))).toBeTruthy();
  });

  it("rejects bytes whose transaction id is not the fee payer", async () => {
    // Catches the mistake here, where the message can name it, rather than letting the
    // facilitator answer with an opaque InvalidSignature.
    const wrong = buildUnsignedPayment(
      { ...requirements(), extra: { feePayer: BUYER } },
      BUYER,
    );
    const key = PrivateKey.generateECDSA();
    const signed = await Transaction.fromBytes(wrong.bytes).sign(key);

    expect(() => payloadFromSignedBytes(requirements(), signed.toBytes())).toThrow(/fee payer/);
  });

  it("rejects bytes that are not a transaction at all", () => {
    expect(() => payloadFromSignedBytes(requirements(), new Uint8Array([1, 2, 3]))).toThrow();
  });
});
