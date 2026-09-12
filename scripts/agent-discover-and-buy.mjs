/**
 * An agent that finds a service it has never heard of, and pays it.
 *
 * Nothing is configured here except a topic id and a need. No URL, no API key, no
 * account with the seller, no prior relationship of any kind. The agent:
 *
 *   1. reads the open HCS directory over the public mirror node — no key required
 *   2. picks the cheapest listing whose skills match what it wants
 *   3. fetches that service's A2A agent card to learn how to talk to it
 *   4. negotiates: states its budget, and takes the counter-offer if the job is too big
 *   5. pays the 402 and takes delivery
 *   6. verifies the receipt against the ledger before trusting the answer
 *
 * Step 6 is the one that makes the rest safe. Discovery hands you an address a stranger
 * posted; the receipt is what tells you the thing at that address actually did the work
 * and charged what it said it would.
 *
 *   node scripts/agent-discover-and-buy.mjs --need oracle --budget 500000
 */
import "dotenv/config";
import { readDirectory } from "../packages/receipts/src/index.ts";
import { verifyFromMirror, formatChecks } from "../packages/receipts/src/index.ts";
import { buildPayment } from "../apps/buyer-cli/src/index.ts";
import { PRICE_BOOKS } from "../packages/worker/src/pricebooks.ts";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const need = arg("need", "oracle");
const budget = BigInt(arg("budget", "500000"));
const topic = arg("topic", process.env.REGISTRY_TOPIC_ID);
const mirror = process.env.MIRROR_NODE_URL;

if (!topic) {
  console.error("no directory — set REGISTRY_TOPIC_ID or pass --topic");
  process.exit(2);
}

const say = (k, v) => console.log(`  ${k.padEnd(14)}${v}`);

// ── 1. discover ───────────────────────────────────────────────────────────────
console.log(`\n1. reading the directory (topic ${topic}) — no key, no account`);
const entries = await readDirectory(topic, mirror ? { baseUrl: mirror } : {});
say("services", entries.length);

const offers = entries.flatMap((e) =>
  e.listing.skills
    .filter((s) => s.id.includes(need))
    .map((s) => ({ entry: e, skill: s, from: BigInt(s.from) })),
);
if (offers.length === 0) {
  console.error(`nothing in the directory sells "${need}"`);
  process.exit(1);
}

offers.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
const pick = offers[0];
say("matching", `${offers.length} offer(s) for "${need}"`);
say("cheapest", `${pick.skill.id} from ${pick.skill.from} tinybar`);
say("listed by", pick.entry.submitter);
say("uaid", `${pick.entry.listing.uaid.slice(0, 52)}…`);

// ── 2. read its card ──────────────────────────────────────────────────────────
const base = pick.entry.listing.url;
console.log(`\n2. fetching its agent card`);
const card = await fetch(`${base}/.well-known/agent-card.json`).then((r) => r.json());
say("name", card.name);
say("identity", card.id === pick.entry.listing.uaid ? "matches the listing" : "DIFFERS FROM LISTING");
say("pays via", card.interfaces.find((i) => i.type === "x402")?.url ?? "(no x402 interface)");

// The listing is a claim by whoever posted it. The card is a claim by the service. They
// agreeing is worth checking and is still not proof — the receipt at the end is.
if (card.id !== pick.entry.listing.uaid) {
  console.error("\nthe service does not claim the identity it was listed under — stopping");
  process.exit(1);
}

// ── 3. negotiate ──────────────────────────────────────────────────────────────
// The interesting case is the one where the answer is "that costs more than you have".
// Walking away is what this script used to do, and it is a waste of a conversation: the
// seller can price a smaller version of the same job without touching the network, so
// asking is free. Scope moves, the rate does not.
console.log(`
3. negotiating — telling it the budget rather than guessing`);
const params =
  need === "oracle"
    ? {
        url: "https://www.whitehouse.gov/presidential-actions/",
        select: ".wp-block-post-title",
        max: 25,
      }
    : { max: 100 };

const a2a = card.interfaces.find((i) => i.type === "jsonrpc")?.url;
let quote;

if (a2a) {
  const talk = async (data, contextId) => {
    const res = await fetch(a2a, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: String(Date.now()),
        method: "message/send",
        params: {
          message: {
            role: "user",
            messageId: crypto.randomUUID(),
            ...(contextId ? { contextId } : {}),
            parts: [{ kind: "data", data }],
          },
        },
      }),
    }).then((r) => r.json());
    if (res.error) throw new Error(res.error.message);
    const parts = res.result.parts ?? [];
    return {
      contextId: res.result.contextId,
      text: parts.find((p) => p.text)?.text ?? "",
      data: parts.find((p) => p.data)?.data ?? {},
    };
  };

  say("asking for", `${params.max} records, budget ${budget} tinybar`);
  const opened = await talk({ capability: pick.skill.id, params, budgetTinybar: String(budget) });
  say("seller says", opened.text);

  if (opened.data.outcome === "rejected") {
    console.log(`
  the floor price is ${opened.data.floor.priceTinybar} tinybar — nothing fits ${budget}.`);
    console.log(`  walking away, having paid nothing and learned the number.`);
    process.exit(0);
  }

  if (opened.data.outcome === "counter-offer") {
    const { asked, offer } = opened.data;
    say("asked cost", `${asked.priceTinybar} tinybar for ${asked.params.max} records`);
    say("offered", `${offer.priceTinybar} tinybar for ${offer.params.max} records`);
    // The seller says it did not move the rate. That is checkable rather than trustworthy:
    // price the counter-offer from the published book and see if it agrees.
    const book = opened.data.priceBook;
    const expected =
      BigInt(book.base) +
      BigInt(book.perStep) * BigInt(offer.plan.steps) +
      BigInt(book.perPage) * BigInt(offer.plan.pages) +
      BigInt(book.perSecond) * BigInt(Math.ceil(offer.plan.estimatedMs / 1000));
    const honest = expected === BigInt(offer.priceTinybar);
    say("rate check", honest ? "counter-offer is at the published rate" : "RATE DOES NOT MATCH THE BOOK");
    if (!honest) {
      console.error("\n  the counter-offer is not priced from the published book — refusing it");
      process.exit(1);
    }
  }

  const agreed = await talk({ accept: true }, opened.contextId);
  say("agreed", `${agreed.data.amount} tinybar`);
  quote = {
    run: agreed.data.run,
    price: { amount: agreed.data.amount },
    plan: { outline: ["negotiated over A2A"] },
  };
} else {
  // A seller with no negotiation endpoint still sells the old way.
  say("no /a2a", "falling back to a plain quote");
  const q = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: pick.skill.id, params }),
  }).then((r) => r.json());
  if (q.error) {
    console.error(`quote refused: ${q.error} ${q.message ?? ""}`);
    process.exit(1);
  }
  if (BigInt(q.price.amount) > budget) {
    console.log(`
  over budget (${budget}) and nothing to negotiate with — walking away.`);
    process.exit(0);
  }
  quote = q;
}

const amount = BigInt(quote.price.amount);
if (amount > budget) {
  console.error(`
  agreed price ${amount} is over the budget ${budget} — refusing to pay`);
  process.exit(1);
}

// ── 4. pay ────────────────────────────────────────────────────────────────────
console.log(`\n4. paying the 402`);
const challenge = await fetch(quote.run, { method: "POST" });
if (challenge.status !== 402) {
  console.error(`expected 402, got ${challenge.status}`);
  process.exit(1);
}
const { accepts } = await challenge.json();
// Awaited: `buildPayment` signs a transaction, so it is async. Forgetting that sends
// the string "[object Promise]" as the payment header, and the seller rightly rejects it.
const header = await buildPayment(accepts[0], {
  accountId: process.env.BUYER_ACCOUNT_ID,
  privateKey: process.env.BUYER_PRIVATE_KEY,
  network: process.env.HEDERA_NETWORK ?? "testnet",
});

const paid = await fetch(quote.run, { method: "POST", headers: { "payment-signature": header } });
const body = await paid.json();
if (!paid.ok) {
  console.error(`job failed (${paid.status}): ${body.error} ${body.message ?? ""}`);
  process.exit(1);
}
say("items", body.result?.items?.length ?? 0);
say("charged", `${body.price?.charged} ${body.price?.unit}`);
say("receipt", `topic ${body.receipt.topicId} seq ${body.receipt.sequenceNumber}`);

// ── 5. verify before believing any of it ──────────────────────────────────────
console.log(`\n5. verifying the receipt against the ledger`);
const out = await verifyFromMirror(
  {
    topicId: body.receipt.topicId,
    sequenceNumber: body.receipt.sequenceNumber,
    result: body.result,
    expectedSubmitter: card["x-hedera"].account,
    priceBook: PRICE_BOOKS[pick.skill.id],
    ...(body.artifacts
      ? {
          pageHtml: body.artifacts.html,
          screenshot: Buffer.from(body.artifacts.screenshotBase64, "base64"),
        }
      : {}),
    ...(body.retrievalProof ? { retrievalProof: body.retrievalProof } : {}),
  },
  mirror ? { baseUrl: mirror } : {},
);

console.log(formatChecks(out.checks));
console.log(
  `\n  ${out.ok ? "VERIFIED" : "FAILED"} — ${out.checks.filter((c) => c.ok).length}/${out.checks.length} checks`,
);
console.log(
  `\nThe agent started with a topic id and a sentence. It ended holding an answer it can` +
    `\nprove was delivered, at a price it could check, from a service it had never heard of.`,
);
process.exit(out.ok ? 0 : 1);
