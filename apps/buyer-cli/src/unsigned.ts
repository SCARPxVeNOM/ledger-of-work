import {
  AccountId,
  Hbar,
  HbarUnit,
  TokenId,
  Transaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import type { PaymentRequirements } from "./pay.js";

/**
 * Building an x402 payment for a wallet to sign.
 *
 * Split out from `buildPayment` because a wallet does the signing: this side constructs
 * the transaction and assembles the payload, the wallet supplies the signature, and
 * neither half ever sees the other's secrets.
 *
 * The construction is the part most likely to be wrong and is fully testable here —
 * `transactionId.accountId` must be the facilitator's fee payer, not the buyer, and
 * getting that wrong produces a payload that fails `/verify` with no obvious clue why.
 * Only the wallet round-trip itself needs a wallet.
 */

/**
 * Testnet consensus nodes.
 *
 * A transaction has to be frozen against specific nodes before it can be signed, and in
 * a browser there is no operator-configured client to choose them. Pinning a small set
 * is fine — the facilitator submits to one of them — but it is a real coupling worth
 * naming rather than hiding.
 */
export const TESTNET_NODE_ACCOUNTS = ["0.0.3", "0.0.4", "0.0.5"];

export interface UnsignedPayment {
  /** Frozen, unsigned transaction bytes for the wallet to sign. */
  bytes: Uint8Array;
  /** The transaction id, which by scheme rule belongs to the fee payer. */
  transactionId: string;
}

/**
 * Build the frozen, unsigned transfer a wallet will be asked to sign.
 *
 * Throws rather than guessing on anything ambiguous: a wallet prompt is the last place a
 * user should be asked to approve something this code was unsure about.
 */
export function buildUnsignedPayment(
  requirements: PaymentRequirements,
  buyerAccountId: string,
  nodeAccountIds: string[] = TESTNET_NODE_ACCOUNTS,
): UnsignedPayment {
  if (!requirements.extra?.feePayer) {
    throw new Error("payment requirements carry no feePayer; cannot build a payable transaction");
  }
  if (!/^\d+$/.test(requirements.amount)) {
    throw new Error(`amount "${requirements.amount}" must be an integer in the asset's smallest units`);
  }

  const buyer = AccountId.fromString(buyerAccountId);
  const payTo = AccountId.fromString(requirements.payTo);
  const feePayer = AccountId.fromString(requirements.extra.feePayer);

  const tx = new TransferTransaction()
    // The scheme requires transactionId.accountId == extra.feePayer. The buyer signs a
    // transaction whose id belongs to the facilitator, which pays the network fee and
    // submits it.
    .setTransactionId(TransactionId.generate(feePayer))
    .setNodeAccountIds(nodeAccountIds.map((id) => AccountId.fromString(id)));

  if (requirements.asset === "0.0.0") {
    const amount = Hbar.from(requirements.amount, HbarUnit.Tinybar);
    tx.addHbarTransfer(buyer, amount.negated()).addHbarTransfer(payTo, amount);
  } else {
    const token = TokenId.fromString(requirements.asset);
    const units = BigInt(requirements.amount);
    tx.addTokenTransfer(token, buyer, -units).addTokenTransfer(token, payTo, units);
  }

  const frozen = tx.freeze();
  return {
    bytes: frozen.toBytes(),
    transactionId: frozen.transactionId?.toString() ?? "",
  };
}

/**
 * Wrap signed transaction bytes into the x402 payload a resource server expects.
 *
 * Kept separate from signing so it can be tested against bytes from any source — a
 * wallet, the local signer, or a fixture.
 */
export function payloadFromSignedBytes(
  requirements: PaymentRequirements,
  signedBytes: Uint8Array,
): string {
  // Reject anything that is not a decodable transaction before it reaches the seller;
  // an opaque "InvalidSignature" from the facilitator is a much worse error to debug.
  const decoded = Transaction.fromBytes(signedBytes);
  if (!decoded.transactionId) {
    throw new Error("signed bytes carry no transaction id");
  }
  if (decoded.transactionId.accountId?.toString() !== requirements.extra.feePayer) {
    throw new Error(
      `signed transaction id belongs to ${decoded.transactionId.accountId?.toString()}, but the scheme requires the fee payer ${requirements.extra.feePayer}`,
    );
  }

  const payload = {
    x402Version: 2,
    scheme: "exact",
    network: requirements.network,
    accepted: requirements,
    payload: { transaction: Buffer.from(signedBytes).toString("base64") },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}
