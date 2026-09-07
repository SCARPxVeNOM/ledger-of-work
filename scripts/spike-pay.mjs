/**
 * Spike A — one real x402 payment through the hosted Blocky402 facilitator.
 *
 * This is the highest-risk unknown in the design, and it settles two questions that the
 * documentation disagrees about:
 *
 *   1. Does the settlement response name the id field `transaction` or `transactionId`?
 *   2. Is `payer` the buying account or the fee payer? Blocky402's example says the
 *      buyer; Hedera's docs example says the fee payer. The receipt records "the
 *      identity of the paying agent", so guessing wrong puts a false claim on an
 *      immutable topic.
 *
 * Throwaway. Prints both responses verbatim.
 */
import "dotenv/config";
import {
  Client,
  PrivateKey,
  AccountId,
  Hbar,
  HbarUnit,
  TransferTransaction,
  TransactionId,
} from "@hiero-ledger/sdk";

const FACILITATOR = process.env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com";
const NETWORK = process.env.X402_NETWORK ?? "hedera:testnet";
const AMOUNT_TINYBAR = "184000"; // 0.00184 HBAR — mirrors the worked example in the tests

const buyerId = AccountId.fromString(process.env.BUYER_ACCOUNT_ID);
const buyerKey = PrivateKey.fromStringECDSA(process.env.BUYER_PRIVATE_KEY.replace(/^0x/i, ""));
const sellerId = AccountId.fromString(process.env.SELLER_ACCOUNT_ID);

const client = Client.forName(process.env.HEDERA_NETWORK ?? "testnet").setOperator(buyerId, buyerKey);

const jstr = (v) => JSON.stringify(v, null, 2);

try {
  // --- 1. discover the fee payer ------------------------------------------------
  const supported = await (await fetch(`${FACILITATOR}/supported`)).json();
  const kind = supported.kinds.find((k) => k.network === NETWORK && k.scheme === "exact");
  if (!kind) throw new Error(`facilitator does not support exact on ${NETWORK}`);
  const feePayer = kind.extra?.feePayer ?? supported.signers?.["hedera:*"]?.[0];
  if (!feePayer) throw new Error("no feePayer advertised");
  console.log(`fee payer      ${feePayer}`);
  console.log(`buyer          ${buyerId}`);
  console.log(`seller         ${sellerId}`);
  console.log(`amount         ${AMOUNT_TINYBAR} tinybar\n`);

  // --- 2. build the transfer ----------------------------------------------------
  // The scheme requires transactionId.accountId == extra.feePayer. The buyer therefore
  // builds a transaction whose id belongs to the *facilitator* and only partially signs
  // it; the facilitator co-signs as fee payer and submits. Building it with the buyer as
  // the transaction-id account is the natural thing to do and fails verification.
  const amount = Hbar.from(AMOUNT_TINYBAR, HbarUnit.Tinybar);
  const tx = new TransferTransaction()
    .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)))
    .addHbarTransfer(buyerId, amount.negated())
    .addHbarTransfer(sellerId, amount)
    .freezeWith(client);

  const signed = await tx.sign(buyerKey);
  const b64 = Buffer.from(signed.toBytes()).toString("base64");
  console.log(`payload        ${b64.length} base64 chars`);
  console.log(`tx id          ${signed.transactionId.toString()}\n`);

  const requirements = {
    scheme: "exact",
    network: NETWORK,
    amount: AMOUNT_TINYBAR,
    payTo: sellerId.toString(),
    maxTimeoutSeconds: 300,
    asset: "0.0.0",
    extra: { feePayer },
  };

  const body = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: NETWORK,
      accepted: requirements,
      payload: { transaction: b64 },
    },
    paymentRequirements: requirements,
  };

  const post = async (path) => {
    const res = await fetch(`${FACILITATOR}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };

  // --- 3. verify (free, non-destructive) ----------------------------------------
  const verify = await post("/verify");
  console.log(`POST /verify   ${verify.status}`);
  console.log(jstr(verify.json), "\n");
  if (verify.json?.isValid !== true) {
    console.log("stopping: verification failed, nothing was settled.");
    process.exit(1);
  }

  // --- 4. settle ----------------------------------------------------------------
  const settle = await post("/settle");
  console.log(`POST /settle   ${settle.status}`);
  console.log(jstr(settle.json), "\n");

  // --- 5. answer the two open questions -----------------------------------------
  const s = settle.json ?? {};
  const idField = "transactionId" in s ? "transactionId" : "transaction" in s ? "transaction" : null;
  const txId = s.transactionId ?? s.transaction;

  console.log("--- findings -------------------------------------------------");
  console.log(`settlement id field   ${idField ?? "NEITHER — check the response above"}`);
  console.log(`verify.payer          ${verify.json?.payer}`);
  console.log(`settle.payer          ${s.payer}`);
  console.log(
    `settle.payer is       ${
      s.payer === buyerId.toString()
        ? "the BUYER"
        : s.payer === feePayer
          ? "the FEE PAYER"
          : "neither buyer nor fee payer (!)"
    }`,
  );
  console.log(
    `verify.payer is       ${
      verify.json?.payer === buyerId.toString() ? "the BUYER" : verify.json?.payer === feePayer ? "the FEE PAYER" : "neither (!)"
    }`,
  );
  if (txId) console.log(`\nhashscan: https://hashscan.io/testnet/transaction/${txId}`);
} finally {
  client.close();
}
