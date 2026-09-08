/**
 * Usage on the receipt topic, computed from public data.
 *
 * Anyone can run this — including someone who thinks the numbers are inflated. That is
 * the whole reason traction is reported this way rather than asserted: the topic is
 * append-only and the seller cannot edit it.
 */
import "dotenv/config";
import { formatUsage, readUsage } from "../packages/receipts/src/index.ts";

const topicId = process.argv[2] ?? process.env.SELLER_TOPIC_ID;
if (!topicId) {
  console.error("usage: node scripts/usage.mjs <topicId>   (or set SELLER_TOPIC_ID)");
  process.exit(2);
}

const report = await readUsage(topicId, {
  ...(process.env.MIRROR_NODE_URL ? { baseUrl: process.env.MIRROR_NODE_URL } : {}),
  limit: 100,
});

console.log(formatUsage(report));
console.log(`\nverify for yourself:`);
console.log(`  https://hashscan.io/testnet/topic/${topicId}`);
console.log(`  ${process.env.MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com/api/v1"}/topics/${topicId}/messages`);
