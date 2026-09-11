/**
 * Recurring payment, as a standing order of Hedera Scheduled Transactions.
 *
 * ── The problem with pay-per-call, for a buyer that calls often ─────────────────
 * x402 settles one job at a time, which is exactly right for a stranger buying once. It
 * is a poor fit for an agent that wants the same job every hour: a signature per call, a
 * facilitator round trip per call, and no way for either side to know the relationship
 * will still exist in ten minutes.
 *
 * ── What a standing order is here ───────────────────────────────────────────────
 * The buyer creates N transfers ahead of time, each scheduled to execute at its own
 * future moment, and signs them all now. The money does not move until each moment
 * arrives. What makes this more than a cron job is that the seller can *check* it: the
 * schedules are public entities on the ledger, so before doing any work the seller can
 * confirm the payments exist, are fully signed and cannot be unilaterally withdrawn.
 *
 * Neither side has to trust the other, and neither holds the other's key — the buyer's
 * funds stay in the buyer's account until the scheduled second, and the seller has a
 * commitment it can verify rather than a promise it has to believe.
 *
 * `setWaitForExpiry(true)` is what makes this work. Without it a scheduled transfer
 * executes the instant its signatures are collected, which for a single-signature
 * transfer means immediately — a standing order that all fires at once.
 *
 *   node scripts/standing-order.mjs create --times 3 --every 45 --amount 321000
 *   node scripts/standing-order.mjs status --schedule 0.0.x
 */
import "dotenv/config";
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  ScheduleCreateTransaction,
  Timestamp,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const arg = (n, fallback) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const mode = process.argv[2] ?? "create";
const network = process.env.HEDERA_NETWORK ?? "testnet";
const MIRROR =
  process.env.MIRROR_NODE_URL ?? `https://${network}.mirrornode.hedera.com/api/v1`;

function buyer() {
  const id = process.env.BUYER_ACCOUNT_ID;
  const key = process.env.BUYER_PRIVATE_KEY;
  if (!id || !key) {
    console.error("set BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY in .env");
    process.exit(2);
  }
  const client = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(id), PrivateKey.fromStringECDSA(key));
  return { client, id };
}

if (mode === "create") {
  const seller = arg("to", process.env.SELLER_ACCOUNT_ID);
  if (!seller) {
    console.error("no recipient — set SELLER_ACCOUNT_ID or pass --to");
    process.exit(2);
  }
  const times = Number(arg("times", "3"));
  const every = Number(arg("every", "60"));
  const amount = Number(arg("amount", "321000"));

  if (!Number.isInteger(times) || times < 1 || times > 10) {
    console.error("--times must be between 1 and 10");
    process.exit(2);
  }
  // The network refuses an expiry that is not strictly in the future, and the first one
  // has to leave room for the ScheduleCreate itself to reach consensus.
  if (!Number.isInteger(every) || every < 30) {
    console.error("--every must be at least 30 seconds");
    process.exit(2);
  }

  const { client, id: buyerId } = buyer();

  console.log(`standing order  ${times} payments of ${amount} tinybar, every ${every}s`);
  console.log(`from            ${buyerId}`);
  console.log(`to              ${seller}\n`);

  const schedules = [];
  for (let i = 1; i <= times; i++) {
    const at = new Date(Date.now() + i * every * 1000);

    // A plain transfer: debit the buyer, credit the seller, netting to zero. Only the
    // buyer's signature is required, and creating the schedule as the buyer supplies it.
    const transfer = new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(buyerId), Hbar.fromTinybars(-amount))
      .addHbarTransfer(AccountId.fromString(seller), Hbar.fromTinybars(amount));

    const receipt = await (
      await new ScheduleCreateTransaction()
        .setScheduledTransaction(transfer)
        .setScheduleMemo(`ledger-of-work standing order ${i}/${times}`)
        .setExpirationTime(Timestamp.fromDate(at))
        // Without this the transfer fires the moment signatures are complete — which,
        // for a single-signature transfer signed at creation, is immediately.
        .setWaitForExpiry(true)
        .execute(client)
    ).getReceipt(client);

    const scheduleId = receipt.scheduleId.toString();
    schedules.push({ scheduleId, at });
    console.log(`  ${i}/${times}  ${scheduleId}  executes ${at.toISOString()}`);
  }

  console.log(`\nthe seller can check these before doing any work — no key needed:`);
  for (const s of schedules) console.log(`  ${MIRROR}/schedules/${s.scheduleId}`);
  console.log(`\nwatch one:\n  node scripts/standing-order.mjs status --schedule ${schedules[0].scheduleId}`);
  client.close();
} else if (mode === "status") {
  const scheduleId = arg("schedule");
  if (!scheduleId) {
    console.error("pass --schedule 0.0.x");
    process.exit(2);
  }

  // Read-only, over the public mirror node. This is the half that matters: a seller
  // decides whether to work based on what anyone can see, not on what the buyer says.
  const res = await fetch(`${MIRROR}/schedules/${scheduleId}`);
  if (!res.ok) {
    console.error(`mirror returned ${res.status} for schedule ${scheduleId}`);
    process.exit(1);
  }
  const s = await res.json();

  const executed = Boolean(s.executed_timestamp);
  const expiry = s.expiration_time ? new Date(Number(s.expiration_time.split(".")[0]) * 1000) : null;

  console.log(`schedule        ${s.schedule_id}`);
  console.log(`memo            ${s.memo ?? ""}`);
  console.log(`creator         ${s.creator_account_id}`);
  console.log(`payer           ${s.payer_account_id}`);
  console.log(`signatures      ${(s.signatures ?? []).length} collected`);
  console.log(`waits for expiry${s.wait_for_expiry ? "  yes" : "  no"}`);
  if (expiry) console.log(`executes at     ${expiry.toISOString()}`);
  console.log(
    `status          ${executed ? `EXECUTED at ${s.executed_timestamp}` : expiry && expiry < new Date() ? "expired without executing" : "PENDING — funds still in the buyer's account"}`,
  );
  console.log(`\nexplorer        https://hashscan.io/${network}/schedule/${scheduleId}`);
} else {
  console.log("usage: node scripts/standing-order.mjs [create|status]");
  process.exit(2);
}
