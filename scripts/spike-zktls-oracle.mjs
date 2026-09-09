/**
 * Spike — is the capability with a real buyer actually provable?
 *
 * `spike-zktls.mjs` proved a Virgo search POST: 40KB of JSON, behind a short-lived bearer
 * token, 28 seconds. That answered "does zkTLS work here at all". It did not answer the
 * question that decides whether any of this ships, which is whether the *oracle* capability
 * can be proven — because that is the one someone would pay to settle a dispute with.
 *
 * whitehouse.gov is a different shape of target in three ways that all matter:
 *   - a plain GET with no credentials, so nothing expires mid-flight
 *   - server-rendered HTML, so the answer is in the document rather than an XHR
 *   - several hundred KB, where Virgo's answer was 40KB
 *
 * Response size is the risk. Proof time scales with how much of the transcript has to be
 * proven, and a capture that takes minutes cannot sit inside a paid request. This measures
 * that, on the real page, matching on the real answer.
 *
 *   node scripts/spike-zktls-oracle.mjs
 */
import "dotenv/config";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

const ZK_CACHE_DIR = ".data/zk-resources";
const PROOF_FILE = ".data/zktls-oracle-proof.json";
const TARGET = "https://www.whitehouse.gov/presidential-actions/";
const SELECT = ".wp-block-post-title";

/** See spike-zktls.mjs — the TLS package ships an empty crypto object for the host to fill. */
async function installTlsCrypto() {
  const { setCryptoImplementation, crypto: tlsCrypto } = await import("@reclaimprotocol/tls");
  if (typeof tlsCrypto.randomBytes === "function") return;
  const { webcryptoCrypto } = await import("@reclaimprotocol/tls/webcrypto");
  setCryptoImplementation(webcryptoCrypto);
}

/** See spike-zktls.mjs — circuits are not in the published package; fetch and cache them. */
async function makeZkOperators() {
  const { makeRemoteFileFetch } = await import("@reclaimprotocol/zk-symmetric-crypto");
  const { makeSnarkJsZKOperator } = await import("@reclaimprotocol/zk-symmetric-crypto/snarkjs");
  const remote = makeRemoteFileFetch();
  const fetcher = {
    async fetch(engine, filename) {
      const path = `${ZK_CACHE_DIR}/${engine}/${filename}`;
      if (existsSync(path)) return new Uint8Array(readFileSync(path));
      const bytes = await remote.fetch(engine, filename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      console.log(`  downloaded ${engine}/${filename} ${(bytes.length / 1e6).toFixed(1)} MB`);
      return bytes;
    },
  };
  const ops = {};
  for (const algorithm of ["chacha20", "aes-128-ctr", "aes-256-ctr"]) {
    ops[algorithm] = makeSnarkJsZKOperator({ algorithm, fetcher });
  }
  return ops;
}

// ── what does the capability actually return, and how big is the page? ────────
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ userAgent: "LedgerOfWork/0.1" });
const res = await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(SELECT, { timeout: 30_000 });

const html = await res.text();
const answer = (
  await page.$$eval(SELECT, (n) => n.map((e) => e.textContent ?? ""))
)[0]
  ?.replace(/\s+/g, " ")
  .trim();
await browser.close();

console.log(`target        ${TARGET}`);
console.log(`status        ${res.status()}`);
console.log(`document      ${html.length} bytes of HTML`);
console.log(`answer        ${answer?.slice(0, 90)}...`);

// Match on the answer itself, not on incidental markup. A proof that the response
// contained `"start"` proves the server replied; a proof that it contained the answer is
// what a dispute actually turns on. Long values are expensive to reveal, so take a
// distinctive prefix rather than the whole title.
const needle = (answer ?? "").slice(0, 48);
if (!needle) {
  console.log("\nFAILED: nothing extracted, nothing to prove");
  process.exit(1);
}
if (!html.includes(needle)) {
  console.log(`\nFAILED: the answer is not in the delivered HTML — this page renders client-side,`);
  console.log(`        so a single response does not carry it and this approach cannot apply.`);
  process.exit(1);
}
console.log(`matching on   "${needle}"`);
console.log(`              (present in the raw HTML, so one response carries the answer)`);

await installTlsCrypto();
const zkOperators = await makeZkOperators();
const { createClaimOnAttestor } = await import("@reclaimprotocol/attestor-core");

const t0 = Date.now();
console.log(`\nasking attestor to witness GET www.whitehouse.gov ...`);

try {
  const proof = await createClaimOnAttestor({
    name: "http",
    params: {
      url: TARGET,
      method: "GET",
      headers: { "user-agent": "LedgerOfWork/0.1", accept: "text/html" },
      responseMatches: [{ type: "contains", value: needle }],
    },
    // The HTTP provider refuses to build a request unless at least one secret parameter
    // is set — it is written for logged-in pages and treats "no credentials" as a
    // misconfiguration. This source needs none, so give it a header that carries nothing.
    secretParams: { headers: { "accept-language": "en-US,en;q=0.9" } },
    ownerPrivateKey: process.env.ZKTLS_OWNER_KEY,
    zkOperators,
    client: { url: "wss://attestor.reclaimprotocol.org:444/ws" },
  });

  const elapsed = Date.now() - t0;
  if (proof.error) {
    console.log(`\nATTESTOR REFUSED after ${elapsed}ms`);
    console.log(JSON.stringify(proof.error, null, 2).slice(0, 800));
    process.exit(1);
  }

  writeFileSync(PROOF_FILE, JSON.stringify(proof, null, 2));

  console.log(`\nPROVEN in ${elapsed}ms`);
  console.log(`attestor      ${proof.signatures?.attestorAddress}`);
  console.log(`identifier    ${proof.claim?.identifier}`);
  console.log(`proof size    ${JSON.stringify(proof).length} bytes`);
  console.log(`\nthe number that decides this: ${(elapsed / 1000).toFixed(1)}s to prove a ${html.length}-byte page`);
  console.log(`saved to ${PROOF_FILE}`);
} catch (err) {
  console.log(`\nFAILED after ${Date.now() - t0}ms`);
  console.log(String(err?.message ?? err).slice(0, 500));
  console.log(String(err?.stack ?? "").split("\n").slice(1, 6).join("\n"));
  process.exit(1);
}
