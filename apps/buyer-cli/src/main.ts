import "dotenv/config";
import { writeFileSync } from "node:fs";
import { buildPayment, type PaymentRequirements } from "./pay.js";

/**
 * A buying agent, in the shape an autonomous one would take.
 *
 * Discovers the capability from the manifest, asks for a quote, reads the 402, pays,
 * and saves the result alongside the receipt locator so it can be verified later by
 * someone who trusts neither party.
 */

const SELLER = process.env.SELLER_URL ?? "http://localhost:8402";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

const capability = arg("capability", "quotes.search_and_extract") as string;
const out = arg("out", "./result.json") as string;

// Anything after --param key=value pairs becomes the job parameters.
const params: Record<string, unknown> = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--param") {
    const pair = process.argv[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const key = pair.slice(0, eq);
      const raw = pair.slice(eq + 1);
      params[key] = /^-?\d+$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
    }
  }
}

console.log(`seller      ${SELLER}`);
console.log(`capability  ${capability}`);
console.log(`params      ${JSON.stringify(params)}\n`);

// --- 1. quote ------------------------------------------------------------------
const quoteRes = await fetch(`${SELLER}/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ capability, params }),
});
const quote = (await quoteRes.json()) as {
  jobId: string;
  run: string;
  plan?: { steps: number; pages: number; outline: string[] };
  price?: { amount: string };
  error?: string;
  message?: string;
};

if (!quoteRes.ok) {
  console.error(`quote failed (${quoteRes.status}): ${quote.error} ${quote.message ?? ""}`);
  process.exit(1);
}

console.log(`quote       ${quote.price?.amount} tinybar for ${quote.plan?.steps} steps / ${quote.plan?.pages} pages`);
for (const line of quote.plan?.outline ?? []) console.log(`              - ${line}`);

// --- 2. trigger the 402 --------------------------------------------------------
const challenge = await fetch(quote.run, { method: "POST" });
if (challenge.status !== 402) {
  console.error(`expected 402, got ${challenge.status}: ${await challenge.text()}`);
  process.exit(1);
}
const { accepts } = (await challenge.json()) as { accepts: PaymentRequirements[] };
const requirements = accepts[0] as PaymentRequirements;
console.log(`\n402         pay ${requirements.amount} tinybar to ${requirements.payTo}`);
console.log(`              fee payer ${requirements.extra.feePayer}, asset ${requirements.asset}`);

// --- 3. pay and retry ----------------------------------------------------------
const header = await buildPayment(requirements, {
  accountId: required("BUYER_ACCOUNT_ID"),
  privateKey: required("BUYER_PRIVATE_KEY"),
  network: (process.env.HEDERA_NETWORK ?? "testnet") as string,
});

console.log(`\nworking...`);
const t0 = Date.now();
const paid = await fetch(quote.run, { method: "POST", headers: { "payment-signature": header } });
const body = (await paid.json()) as {
  result?: unknown;
  receipt?: { topicId: string; sequenceNumber: number; explorer: string };
  price?: { quoted: string; charged: string };
  plan?: { steps: number; pages: number };
  work?: { steps: number; pages: number; sessionMs: number };
  payment?: { txId?: string; payer?: string };
  error?: string;
  message?: string;
};

if (!paid.ok) {
  console.error(`\njob failed (${paid.status}): ${body.error} — ${body.message ?? ""}`);
  if (body.receipt) {
    console.error(`a receipt was still published: topic ${body.receipt.topicId} seq ${body.receipt.sequenceNumber}`);
  }
  process.exit(1);
}

const items = (body.result as { items?: unknown[] })?.items ?? [];
writeFileSync(out, JSON.stringify(body.result, null, 2));

console.log(`\ndone in ${Date.now() - t0}ms`);
console.log(`  items     ${items.length}`);
console.log(`  planned   ${body.plan?.steps} steps, ${body.plan?.pages} pages`);
console.log(`  actual    ${body.work?.steps} steps, ${body.work?.pages} pages, ${body.work?.sessionMs}ms`);
console.log(`  quoted    ${body.price?.quoted} tinybar`);
console.log(`  charged   ${body.price?.charged} tinybar`);
console.log(`  payer     ${body.payment?.payer}`);
console.log(`  tx        ${body.payment?.txId}`);
console.log(`\n  result -> ${out}`);
console.log(`  receipt -> topic ${body.receipt?.topicId} seq ${body.receipt?.sequenceNumber}`);
console.log(`  explorer   ${body.receipt?.explorer}`);
console.log(
  `\nverify it yourself:\n  pnpm verify --topic ${body.receipt?.topicId} --seq ${body.receipt?.sequenceNumber} --result ${out} --capability ${capability}`,
);
