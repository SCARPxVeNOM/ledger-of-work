import { readFileSync } from "node:fs";
import { formatChecks, verifyFromMirror } from "@low/receipts";
import { CATALOGUE } from "@low/worker";

/**
 * Independent receipt verification.
 *
 * Deliberately takes only public inputs: a topic, a sequence number, and the result file
 * the buyer already holds. It reads the public mirror node, needs no credentials, and
 * never contacts the seller. Someone who assumes we are lying can run it.
 *
 * The seller's account is supplied by the caller rather than baked in, because "trust
 * the value the seller told you" would defeat the point — take it from the manifest you
 * fetched, or from an out-of-band source, and check it yourself.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const topicId = arg("topic");
const seq = arg("seq");
const resultPath = arg("result");
const capability = arg("capability");
const submitter = arg("submitter") ?? process.env.SELLER_ACCOUNT_ID;
const mirrorUrl = arg("mirror") ?? process.env.MIRROR_NODE_URL;

if (!topicId || !seq || !resultPath) {
  console.error(`usage: verify --topic <0.0.x> --seq <n> --result <file.json>
                   [--capability <name>] [--submitter <0.0.x>] [--mirror <url>]

Verifies that a result matches its on-chain receipt, that the retrieval happened when
claimed, that the payment settled for the amount recorded, and that the price follows
the seller's published price book. Reads only public data.`);
  process.exit(2);
}

if (!submitter) {
  console.error("need --submitter (the seller's account id) or SELLER_ACCOUNT_ID in the environment");
  process.exit(2);
}

let result: unknown;
try {
  result = JSON.parse(readFileSync(resultPath, "utf8"));
} catch (err) {
  console.error(`could not read ${resultPath}: ${(err as Error).message}`);
  process.exit(2);
}

const priceBook = capability ? CATALOGUE[capability]?.spec.priceBook : undefined;
if (capability && !priceBook) {
  console.error(`unknown capability "${capability}" — cannot check the meter`);
}

console.log(`verifying topic ${topicId} sequence ${seq}`);
console.log(`  result     ${resultPath}`);
console.log(`  submitter  ${submitter}`);
console.log(`  capability ${capability ?? "(not given — meter check will be skipped)"}\n`);

const out = await verifyFromMirror(
  {
    topicId,
    sequenceNumber: Number(seq),
    result,
    expectedSubmitter: submitter,
    ...(priceBook ? { priceBook } : {}),
  },
  mirrorUrl ? { baseUrl: mirrorUrl } : {},
);

console.log(formatChecks(out.checks));

console.log(`\nevidence — re-run these yourself:`);
console.log(`  ${out.evidence.messageUrl}`);
if (out.evidence.transactionUrl) console.log(`  ${out.evidence.transactionUrl}`);
console.log(`  ${out.evidence.hashscanTopicUrl}`);
if (out.evidence.hashscanTransactionUrl) console.log(`  ${out.evidence.hashscanTransactionUrl}`);

console.log(`\n${out.ok ? "VERIFIED" : "FAILED"} — ${out.checks.filter((c) => c.ok).length}/${out.checks.length} checks passed`);
process.exit(out.ok ? 0 : 1);
