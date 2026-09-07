import "dotenv/config";
import { startSeller } from "./server.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env — see .env.example`);
  return v;
}

const seller = await startSeller({
  port: Number(process.env.PORT ?? 8402),
  network: process.env.X402_NETWORK ?? "hedera:testnet",
  facilitatorUrl: process.env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com",
  facilitatorApiKey: process.env.FACILITATOR_API_KEY,
  sellerAccountId: required("SELLER_ACCOUNT_ID"),
  sellerPrivateKey: required("SELLER_PRIVATE_KEY"),
  topicId: required("SELLER_TOPIC_ID"),
});

console.log(`seller listening on http://localhost:${seller.port}`);
console.log(`  manifest   http://localhost:${seller.port}/`);
console.log(`  fee payer  ${seller.feePayer}`);
console.log(`  receipts   https://hashscan.io/testnet/topic/${process.env.SELLER_TOPIC_ID}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    seller.close().then(() => process.exit(0));
  });
}
