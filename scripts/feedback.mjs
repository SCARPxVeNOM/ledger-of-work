/**
 * Post or read tester feedback.
 *
 * The topic has no submit key, so a tester posts from their own Hedera account and the
 * entry is attributable to them. That is the difference between feedback and a
 * testimonial: we cannot edit it, drop it, or be its only author.
 *
 *   node scripts/feedback.mjs read
 *   node scripts/feedback.mjs post --from "ada" --capability virgo.catalogue_search \
 *        --price-clear no --verified yes --notes "the quote outline sold it"
 */
import "dotenv/config";
import {
  AccountId,
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import { buildFeedback, feedbackBytes, formatFeedback, readFeedback } from "../packages/receipts/src/index.ts";

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const bool = (n) => {
  const v = arg(n);
  if (v === undefined) return undefined;
  return /^(y|yes|true|1)$/i.test(v);
};

const mode = process.argv[2];
const network = process.env.HEDERA_NETWORK ?? "testnet";
const topicId = arg("topic") ?? process.env.FEEDBACK_TOPIC_ID;

if (mode === "create") {
  // No submit key, on purpose: anyone may post, including people who disagree with us.
  const accountId = process.env.SELLER_ACCOUNT_ID;
  const key = PrivateKey.fromStringECDSA(process.env.SELLER_PRIVATE_KEY.replace(/^0x/i, ""));
  const client = Client.forName(network).setOperator(AccountId.fromString(accountId), key);
  try {
    const receipt = await (
      await new TopicCreateTransaction()
        .setTopicMemo("ledger-of-work tester feedback v1 (open: no submit key)")
        .setAdminKey(key.publicKey)
        .execute(client)
    ).getReceipt(client);
    console.log(`created feedback topic ${receipt.topicId}`);
    console.log(`\nadd to .env:\n  FEEDBACK_TOPIC_ID=${receipt.topicId}`);
    console.log(`\nhashscan: https://hashscan.io/testnet/topic/${receipt.topicId}`);
  } finally {
    client.close();
  }
} else if (mode === "post") {
  if (!topicId) throw new Error("set FEEDBACK_TOPIC_ID or pass --topic");
  const accountId = arg("account") ?? process.env.BUYER_ACCOUNT_ID;
  const rawKey = arg("key") ?? process.env.BUYER_PRIVATE_KEY;
  if (!accountId || !rawKey) throw new Error("need an account and key to post — yours, not ours");

  const record = buildFeedback({
    from: arg("from") ?? accountId,
    capability: arg("capability"),
    priceWasLegible: bool("price-clear"),
    didVerify: bool("verified"),
    wanted: arg("wanted"),
    notes: arg("notes"),
  });

  const client = Client.forName(network).setOperator(
    AccountId.fromString(accountId),
    PrivateKey.fromStringECDSA(rawKey.replace(/^0x/i, "")),
  );
  try {
    const receipt = await (
      await new TopicMessageSubmitTransaction()
        .setTopicId(topicId)
        .setMessage(feedbackBytes(record))
        .execute(client)
    ).getReceipt(client);
    console.log(`posted as ${accountId}, sequence ${receipt.topicSequenceNumber}`);
    console.log(`https://hashscan.io/testnet/topic/${topicId}`);
  } finally {
    client.close();
  }
} else {
  if (!topicId) throw new Error("set FEEDBACK_TOPIC_ID or pass --topic");
  const entries = await readFeedback(topicId, {
    ...(process.env.MIRROR_NODE_URL ? { baseUrl: process.env.MIRROR_NODE_URL } : {}),
    // Every account the project controls, so our own entries are never counted as
    // external feedback.
    ownAccounts: [process.env.SELLER_ACCOUNT_ID, process.env.BUYER_ACCOUNT_ID].filter(Boolean),
  });
  console.log(formatFeedback(entries));
  console.log(`topic https://hashscan.io/testnet/topic/${topicId}`);
}
