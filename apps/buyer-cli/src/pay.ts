import {
  AccountId,
  Client,
  Hbar,
  HbarUnit,
  PrivateKey,
  TokenId,
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
  const buyerId = AccountId.fromString(credentials.accountId);
  const buyerKey = PrivateKey.fromStringECDSA(credentials.privateKey.replace(/^0x/i, ""));
  const client = Client.forName(credentials.network ?? "testnet").setOperator(buyerId, buyerKey);

  try {
    const payTo = AccountId.fromString(requirements.payTo);
    const tx = new TransferTransaction().setTransactionId(
      TransactionId.generate(AccountId.fromString(requirements.extra.feePayer)),
    );

    if (requirements.asset === "0.0.0") {
      const amount = Hbar.from(requirements.amount, HbarUnit.Tinybar);
      tx.addHbarTransfer(buyerId, amount.negated()).addHbarTransfer(payTo, amount);
    } else {
      // HTS amounts are already in the token's smallest units, so no conversion here —
      // the seller advertised the amount in those units. The recipient must have
      // associated the token or settlement fails with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
      // that is a setup concern, not something to paper over at signing time.
      const token = TokenId.fromString(requirements.asset);
      const units = BigInt(requirements.amount);
      tx.addTokenTransfer(token, buyerId, -units).addTokenTransfer(token, payTo, units);
    }

    tx.freezeWith(client);

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
