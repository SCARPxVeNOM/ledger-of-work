import {
  AccountId,
  Client,
  Hbar,
  HbarUnit,
  PrivateKey,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { feePayer: string };
}

export interface BuyerCredentials {
  accountId: string;
  privateKey: string;
  network?: string;
}

/**
 * Build and partially sign the payment a 402 challenge asked for.
 *
 * The one thing that is easy to get wrong: `transactionId.accountId` must be the
 * facilitator's fee payer, not the buyer. The buyer is signing a transaction the
 * *facilitator* will submit and pay fees for, so the id belongs to the facilitator.
 * Building it with the buyer as the transaction-id account produces a payload that
 * fails `/verify` with no obvious clue why.
 *
 * The buyer signs only their own half; the facilitator co-signs as fee payer.
 */
export async function buildPayment(
  requirements: PaymentRequirements,
  credentials: BuyerCredentials,
): Promise<string> {
  if (requirements.asset !== "0.0.0") {
    throw new Error(
      `this client only pays in HBAR; the seller asked for asset ${requirements.asset}`,
    );
  }

  const buyerId = AccountId.fromString(credentials.accountId);
  const buyerKey = PrivateKey.fromStringECDSA(credentials.privateKey.replace(/^0x/i, ""));
  const client = Client.forName(credentials.network ?? "testnet").setOperator(buyerId, buyerKey);

  try {
    const amount = Hbar.from(requirements.amount, HbarUnit.Tinybar);
    const tx = new TransferTransaction()
      .setTransactionId(TransactionId.generate(AccountId.fromString(requirements.extra.feePayer)))
      .addHbarTransfer(buyerId, amount.negated())
      .addHbarTransfer(AccountId.fromString(requirements.payTo), amount)
      .freezeWith(client);

    const signed = await tx.sign(buyerKey);

    const payload = {
      x402Version: 2,
      scheme: "exact",
      network: requirements.network,
      accepted: requirements,
      payload: { transaction: Buffer.from(signed.toBytes()).toString("base64") },
    };

    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  } finally {
    client.close();
  }
}
