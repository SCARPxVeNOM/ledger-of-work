import "dotenv/config";
import { startSeller } from "./server.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env — see .env.example`);
  return v;
}

/**
 * The published conversion rate. Fixed and declared rather than fetched: a buyer must be
 * able to reproduce the price from the manifest alone, and an oracle-derived rate would
 * make yesterday's receipt unverifiable today.
 */
const paymentToken = process.env.PAYMENT_TOKEN_ID
  ? {
      id: process.env.PAYMENT_TOKEN_ID,
      symbol: process.env.PAYMENT_TOKEN_SYMBOL ?? "WORK",
      decimals: Number(process.env.PAYMENT_TOKEN_DECIMALS ?? 2),
      unitsPerTinybar: process.env.PAYMENT_TOKEN_RATE ?? "0.001",
    }
  : undefined;

const seller = await startSeller({
  port: Number(process.env.PORT ?? 8402),
  network: process.env.X402_NETWORK ?? "hedera:testnet",
  facilitatorUrl: process.env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com",
  facilitatorApiKey: process.env.FACILITATOR_API_KEY,
  sellerAccountId: required("SELLER_ACCOUNT_ID"),
  sellerPrivateKey: required("SELLER_PRIVATE_KEY"),
  topicId: required("SELLER_TOPIC_ID"),
  paymentToken,
});

console.log(`seller listening on http://localhost:${seller.port}`);
console.log(`  manifest   http://localhost:${seller.port}/`);
console.log(`  fee payer  ${seller.feePayer}`);
console.log(`  receipts   https://hashscan.io/testnet/topic/${process.env.SELLER_TOPIC_ID}`);
console.log(
  `  assets     HBAR${paymentToken ? ` + ${paymentToken.symbol} (${paymentToken.id}) at ${paymentToken.unitsPerTinybar} units/tinybar` : ""}`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    seller.close().then(() => process.exit(0));
  });
}
