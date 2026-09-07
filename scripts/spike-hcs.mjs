/**
 * Spike B — prove the receipt round-trip on real testnet.
 *
 * Creates a topic with a submit key, submits one receipt-shaped message, then polls the
 * mirror node REST API until it appears. Answers three questions the design depends on:
 *
 *   1. Does a receipt-shaped payload fit in one chunk in practice?
 *   2. How long is mirror-node lag really, so the verifier's retry budget is grounded?
 *   3. Does payer_account_id come back as the submitting account, so the verifier's
 *      "submitter is authorized" check actually has something to check?
 *
 * Throwaway. The real publisher lives in packages/receipts.
 */
import "dotenv/config";
import {
  Client,
  PrivateKey,
  AccountId,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";

const MIRROR = process.env.MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com/api/v1";
const accountId = AccountId.fromString(process.env.SELLER_ACCOUNT_ID);
const key = PrivateKey.fromStringECDSA(process.env.SELLER_PRIVATE_KEY.replace(/^0x/i, ""));

const client = Client.forName(process.env.HEDERA_NETWORK ?? "testnet").setOperator(accountId, key);

const log = (...a) => console.log(...a);

try {
  // --- create the topic ---------------------------------------------------------
  // submitKey matters: without it anyone can post a forged receipt to our topic and the
  // verifier's submitter check has nothing to reject.
  let topicId = process.env.SELLER_TOPIC_ID;
  if (topicId) {
    log(`reusing topic ${topicId}`);
  } else {
    const t0 = Date.now();
    const receipt = await (
      await new TopicCreateTransaction()
        .setTopicMemo("ledger-of-work receipts v1")
        .setAdminKey(key.publicKey)
        .setSubmitKey(key.publicKey)
        .execute(client)
    ).getReceipt(client);
    topicId = receipt.topicId.toString();
    log(`created topic  ${topicId}  (${Date.now() - t0}ms)`);
    log(`  -> add to .env as SELLER_TOPIC_ID=${topicId}`);
  }

  // --- submit a receipt-shaped message ------------------------------------------
  const receiptBody = {
    v: 1,
    kind: "delivery",
    jobId: "01JBQZK4T9XN2M7V0S3H8WQPCD",
    capability: "quotes.search_and_extract",
    resultHash: `sha256:${"9f2b".repeat(16)}`,
    sources: ["https://quotes.toscrape.com/tag/love/", "https://quotes.toscrape.com/tag/love/page/2/"],
    startedAt: new Date(Date.now() - 6768).toISOString(),
    finishedAt: new Date().toISOString(),
    work: { steps: 7, pages: 2, sessionMs: 6768 },
    price: { unit: "tinybar", quoted: "184000", charged: "184000" },
    payment: {
      network: "hedera:testnet",
      scheme: "exact",
      asset: "0.0.0",
      txId: "0.0.7162784@1757304723.987654321",
      payer: process.env.BUYER_ACCOUNT_ID,
      payTo: process.env.SELLER_ACCOUNT_ID,
    },
    status: "ok",
  };
  const bytes = Buffer.from(JSON.stringify(receiptBody), "utf8");
  log(`receipt size   ${bytes.length} bytes  (one chunk is 1024)`);
  if (bytes.length > 1024) log("  WARNING: will be chunked; REST readers must reassemble");

  const tSubmit = Date.now();
  const submitReceipt = await (
    await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(bytes)
      .execute(client)
  ).getReceipt(client);
  const seq = submitReceipt.topicSequenceNumber.toString();
  log(`submitted      sequence ${seq}  (${Date.now() - tSubmit}ms to consensus)`);

  // --- read it back through the public, keyless path ----------------------------
  const url = `${MIRROR}/topics/${topicId}/messages/${seq}`;
  let msg = null;
  const tPoll = Date.now();
  for (let attempt = 1; attempt <= 15; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      msg = await res.json();
      log(`mirror lag     ${Date.now() - tPoll}ms (${attempt} attempt${attempt > 1 ? "s" : ""})`);
      break;
    }
    if (res.status !== 404) throw new Error(`mirror node ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!msg) throw new Error(`message never appeared at ${url}`);

  // --- check what the verifier will depend on -----------------------------------
  const decoded = Buffer.from(msg.message, "base64").toString("utf8");
  const roundTripped = decoded === bytes.toString("utf8");
  const chunks = msg.chunk_info?.total ?? 1;

  log("");
  log(`payer_account_id  ${msg.payer_account_id}  ${msg.payer_account_id === process.env.SELLER_ACCOUNT_ID ? "== seller, submitter check works" : "!= seller, UNEXPECTED"}`);
  log(`consensus_ts      ${msg.consensus_timestamp}`);
  log(`running_hash_ver  ${msg.running_hash_version}`);
  log(`chunk_info.total  ${chunks}${chunks === 1 ? "  (single chunk, REST reader stays simple)" : "  (REST does NOT reassemble)"}`);
  log(`byte round-trip   ${roundTripped ? "exact" : "MISMATCH"}`);
  log("");
  log(`hashscan: https://hashscan.io/testnet/topic/${topicId}`);
} finally {
  client.close();
}
