import { existsSync, readFileSync } from "node:fs";
import { formatChecks, verifyFromMirror } from "@low/receipts";
import { PRICE_BOOKS } from "@low/worker/pricebooks";

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

/**
 * Settling in an HTS token means the receipt records the converted amount, so the meter
 * check needs the published rate to compare against. Taken from flags or the environment
 * — in a real deployment a verifier would read it from the seller's manifest and could
 * check that the manifest itself has not changed.
 */
const assetId = arg("asset") ?? process.env.PAYMENT_TOKEN_ID;
const asset =
  assetId && assetId !== "0.0.0"
    ? {
        id: assetId,
        symbol: arg("assetSymbol") ?? process.env.PAYMENT_TOKEN_SYMBOL ?? "TOKEN",
        decimals: Number(arg("assetDecimals") ?? process.env.PAYMENT_TOKEN_DECIMALS ?? 2),
        unitsPerTinybar: arg("assetRate") ?? process.env.PAYMENT_TOKEN_RATE ?? "0.001",
      }
    : undefined;

if (!topicId || !seq || !resultPath) {
  console.error(`usage: verify --topic <0.0.x> --seq <n> --result <file.json>
                   [--capability <name>] [--submitter <0.0.x>] [--mirror <url>]
                   [--asset <0.0.x>] [--assetRate <units-per-tinybar>]

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

/**
 * Look for the artifacts the buyer CLI saves beside the result.
 *
 * Found automatically rather than asked for, because a check nobody runs is not a check
 * — and the whole point of handing the buyer these files is that verifying them should
 * cost nothing.
 */
const artifactBase = resultPath.replace(/\.json$/, "");
const pagePath = `${artifactBase}.page.html`;
const shotPath = `${artifactBase}.screenshot.png`;
const pageHtml = existsSync(pagePath) ? readFileSync(pagePath, "utf8") : undefined;
const screenshot = existsSync(shotPath) ? readFileSync(shotPath) : undefined;

// Read the published price books, not the live catalogue. A verifier is asked about a
// receipt that already exists, and that receipt may name a capability we have since
// stopped selling — in which case the catalogue no longer holds its price and the meter
// check would be skipped rather than run. PRICE_BOOKS keeps retired prices for exactly
// this reason.
const priceBook = capability ? PRICE_BOOKS[capability] : undefined;
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
    ...(asset ? { asset } : {}),
    ...(pageHtml !== undefined ? { pageHtml } : {}),
    ...(screenshot ? { screenshot } : {}),
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
