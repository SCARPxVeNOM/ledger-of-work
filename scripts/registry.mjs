/**
 * A directory of x402 services, on an open HCS topic.
 *
 * Anyone can list a service, from their own Hedera account; nobody can delete a listing,
 * including us. Reading it needs no key and no permission. That is the whole reason it is
 * a topic and not an API — a directory you have to trust the operator of is a strange
 * thing to put in front of a project whose claim is that you need not trust the seller.
 *
 *   node scripts/registry.mjs create                    # once, makes the topic
 *   node scripts/registry.mjs publish --url https://…   # list a service
 *   node scripts/registry.mjs list                      # read the directory
 *   node scripts/registry.mjs find --skill oracle       # search it
 */
import "dotenv/config";
import {
  AccountId,
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import {
  buildListing,
  formatDirectory,
  listingBytes,
  readDirectory,
} from "../packages/receipts/src/index.ts";

const arg = (n, fallback) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const mode = process.argv[2] ?? "list";
const network = process.env.HEDERA_NETWORK ?? "testnet";
const topicId = arg("topic", process.env.REGISTRY_TOPIC_ID);

function operator() {
  const id = process.env.SELLER_ACCOUNT_ID;
  const key = process.env.SELLER_PRIVATE_KEY;
  if (!id || !key) {
    console.error("set SELLER_ACCOUNT_ID and SELLER_PRIVATE_KEY in .env");
    process.exit(2);
  }
  const client = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(id), PrivateKey.fromStringECDSA(key));
  return { client, id };
}

if (mode === "create") {
  const { client } = operator();
  // No submit key, deliberately. A directory only we can write to is a list of our own
  // opinions; the value of this one is that a competitor can add themselves to it.
  const receipt = await (
    await new TopicCreateTransaction()
      .setTopicMemo("x402 service directory — open, no submit key")
      .execute(client)
  ).getReceipt(client);

  console.log(`registry topic  ${receipt.topicId.toString()}`);
  console.log(`explorer        https://hashscan.io/${network}/topic/${receipt.topicId.toString()}`);
  console.log(`\nadd to .env:\n  REGISTRY_TOPIC_ID=${receipt.topicId.toString()}`);
  client.close();
} else if (mode === "publish") {
  if (!topicId) {
    console.error("no registry topic — set REGISTRY_TOPIC_ID or pass --topic");
    process.exit(2);
  }
  const url = arg("url", process.env.PUBLIC_URL ?? "http://localhost:8402");

  // Read the service's own agent card rather than describing it from here. A listing
  // typed out by hand is a third copy of the catalogue and will disagree with the other
  // two within a week.
  const card = await fetch(`${url}/.well-known/agent-card.json`).then((r) => {
    if (!r.ok) throw new Error(`${url} returned ${r.status} for its agent card`);
    return r.json();
  });

  const listing = buildListing({
    uaid: card.id,
    name: card.name,
    url,
    skills: (card.skills ?? []).map((s) => ({ id: s.id, from: s.pricing?.from ?? "0" })),
    receipts: card["x-hedera"]?.receiptsTopic,
    network: card["x-hedera"]?.network ?? `hedera:${network}`,
  });

  const bytes = listingBytes(listing);
  console.log(`listing         ${new TextEncoder().encode(bytes).length} bytes`);
  console.log(`uaid            ${listing.uaid}`);
  console.log(`skills          ${listing.skills.map((s) => s.id).join(", ")}`);

  const { client } = operator();
  const receipt = await (
    await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(bytes)
      .execute(client)
  ).getReceipt(client);

  console.log(`\npublished       topic ${topicId} seq ${receipt.topicSequenceNumber.toString()}`);
  console.log(`explorer        https://hashscan.io/${network}/topic/${topicId}`);
  client.close();
} else if (mode === "list" || mode === "find") {
  if (!topicId) {
    console.error("no registry topic — set REGISTRY_TOPIC_ID or pass --topic");
    process.exit(2);
  }
  const entries = await readDirectory(topicId, {
    ...(process.env.MIRROR_NODE_URL ? { baseUrl: process.env.MIRROR_NODE_URL } : {}),
  });

  const needle = arg("skill");
  const shown = needle
    ? entries.filter((e) => e.listing.skills.some((s) => s.id.includes(needle)))
    : entries;

  console.log(`directory       topic ${topicId}`);
  console.log(`services        ${shown.length}${needle ? ` matching "${needle}"` : ""}\n`);
  console.log(formatDirectory(shown));
  console.log(`\nread it yourself — no key needed:`);
  console.log(
    `  https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?limit=100`,
  );
} else {
  console.log("usage: node scripts/registry.mjs [create|publish|list|find]");
  process.exit(2);
}
