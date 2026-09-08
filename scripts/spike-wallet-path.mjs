/**
 * Prove the wallet-shaped payment path settles, without a wallet.
 *
 * A real wallet would receive the unsigned bytes, sign them, and hand them back. Here the
 * buyer's key stands in for that step, which leaves exactly one thing unverified — the
 * WalletConnect round trip itself — rather than the whole path.
 *
 * Everything else is real: a real quote, a real 402, a real facilitator, real settlement.
 */
import "dotenv/config";
import { PrivateKey, Transaction } from "@hiero-ledger/sdk";
import { buildUnsignedPayment, payloadFromSignedBytes } from "../apps/buyer-cli/src/index.ts";

const SELLER = process.env.SELLER_URL ?? "http://localhost:8402";
const buyerId = process.env.BUYER_ACCOUNT_ID;
const buyerKey = PrivateKey.fromStringECDSA(process.env.BUYER_PRIVATE_KEY.replace(/^0x/i, ""));

const quote = await fetch(`${SELLER}/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ capability: "quotes.search_and_extract", params: { tag: "love", max: 3 } }),
}).then((r) => r.json());
console.log(`quote        ${quote.price.amount} tinybar`);

const challenge = await fetch(quote.run, { method: "POST" });
const { accepts } = await challenge.json();
const requirements = accepts[0];

// 1. Build what a wallet would be asked to sign.
const unsigned = buildUnsignedPayment(requirements, buyerId);
console.log(`unsigned tx  ${unsigned.transactionId}`);
console.log(`  id owner   ${unsigned.transactionId.split("@")[0]} (must be the fee payer ${requirements.extra.feePayer})`);
console.log(`  bytes      ${unsigned.bytes.length}`);

// 2. Sign — this is the only step a wallet would do differently.
const signed = await Transaction.fromBytes(unsigned.bytes).sign(buyerKey);
console.log(`signed       ${signed.toBytes().length} bytes`);

// 3. Wrap and pay.
const header = payloadFromSignedBytes(requirements, signed.toBytes());
const paid = await fetch(quote.run, { method: "POST", headers: { "payment-signature": header } });
const body = await paid.json();

if (!paid.ok) {
  console.log(`\nFAILED ${paid.status}: ${body.error} — ${body.message ?? ""}`);
  process.exit(1);
}
console.log(`\nsettled      ${body.price.charged} ${body.price.unit}`);
console.log(`payer        ${body.payment.payer}`);
console.log(`receipt      topic ${body.receipt.topicId} seq ${body.receipt.sequenceNumber}`);
console.log(`items        ${body.result.items.length}`);
console.log(`\nThe only untested step is the WalletConnect round trip itself.`);
