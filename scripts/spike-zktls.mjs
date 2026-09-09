/**
 * Spike — can we prove the retrieval itself, not just the delivery?
 *
 * The receipt today commits to what the seller chose to return, so a fabricated answer
 * hashes faithfully. zkTLS closes that by proving bytes genuinely came from a site's TLS
 * session. The obstacle looked fatal: zkTLS proves one HTTPS response, while these jobs
 * are multi-step browser sessions.
 *
 * The idea under test: **the browser does the navigating, and zkTLS proves the single
 * response that carries the answer.** Virgo renders its results from one POST, so if that
 * request can be replayed through an independent attestor, the answer is provably from
 * the source rather than from us.
 *
 * Throwaway. Run in stages so a failure says which stage failed:
 *   node scripts/spike-zktls.mjs capture     # what does the browser actually send?
 *   node scripts/spike-zktls.mjs prove       # can an attestor witness it?
 */
import "dotenv/config";
import nodeCrypto from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

/**
 * Register the TLS crypto implementation before using the attestor SDK.
 *
 * `@reclaimprotocol/tls` ships `export const crypto = {}` and a `setCryptoImplementation`
 * that fills it in. attestor-core imports that same empty object and calls
 * `crypto.randomBytes(...)` on it, so without this every claim dies instantly on
 * "crypto.randomBytes is not a function" — which reads like a Node/WebCrypto mismatch and
 * is nothing of the sort. Shimming `globalThis.crypto` does not help, because the binding
 * is an imported module object rather than the global.
 *
 * This is the documented setup step, not a workaround: the package deliberately leaves
 * the implementation to the host so a browser, Node, or pure-JS build can each supply
 * their own.
 */
async function installTlsCrypto() {
  const { setCryptoImplementation, crypto: tlsCrypto } = await import("@reclaimprotocol/tls");
  if (typeof tlsCrypto.randomBytes === "function") return;

  const { webcryptoCrypto } = await import("@reclaimprotocol/tls/webcrypto");
  setCryptoImplementation(webcryptoCrypto);

  if (typeof tlsCrypto.randomBytes !== "function") {
    throw new Error("registering the TLS crypto implementation did not take effect");
  }
}

/**
 * Build the ZK operators, fetching circuits over the network and caching them on disk.
 *
 * Proving to the attestor that we hold the TLS session key needs the AES/ChaCha circuits.
 * On Node the SDK defaults to reading them from a `resources/` directory that only exists
 * in the source repo — the published package omits it, so the default path is a guaranteed
 * ENOENT. Its remote mode is no better here: the fallback base URL is the browser build's
 * relative `/browser-rpc/resources`, which is not a URL Node can fetch.
 *
 * So supply the fetcher directly. It pulls from the commit the package itself pins, and
 * writes each file under `.data/` so the multi-megabyte download happens once.
 */
async function makeZkOperators() {
  const { makeRemoteFileFetch } = await import("@reclaimprotocol/zk-symmetric-crypto");
  const { makeSnarkJsZKOperator } = await import("@reclaimprotocol/zk-symmetric-crypto/snarkjs");

  const remote = makeRemoteFileFetch();
  const fetcher = {
    async fetch(engine, filename) {
      const path = `${ZK_CACHE_DIR}/${engine}/${filename}`;
      if (existsSync(path)) return new Uint8Array(readFileSync(path));

      const started = Date.now();
      const bytes = await remote.fetch(engine, filename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      console.log(
        `  downloaded ${engine}/${filename}  ${(bytes.length / 1e6).toFixed(1)} MB  ${Date.now() - started}ms`,
      );
      return bytes;
    },
  };

  // Which cipher the handshake settles on is the server's choice, so make all three
  // available rather than guessing.
  const operators = {};
  for (const algorithm of ["chacha20", "aes-128-ctr", "aes-256-ctr"]) {
    operators[algorithm] = makeSnarkJsZKOperator({ algorithm, fetcher });
  }
  return operators;
}

const STAGE = process.argv[2] ?? "capture";
const ZK_CACHE_DIR = ".data/zk-resources";
const CAPTURE_FILE = ".data/zktls-capture.json";
const PROOF_FILE = ".data/zktls-proof.json";
const SEARCH_URL =
  "https://search.lib.virginia.edu/search?q=keyword:%20climate%20change&pool=uva_library";

// ── stage 1: watch the browser and record the answer-bearing request ──────────
async function capture() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: "LedgerOfWork/0.1" });
  const page = await ctx.newPage();

  let captured = null;

  page.on("response", async (res) => {
    const req = res.request();
    // The one that carries results: a POST to the search pool returning sizeable JSON.
    if (req.method() !== "POST" || !req.url().includes("/api/search")) return;
    if (req.url().includes("/facets")) return;
    try {
      const body = await res.text();
      if (body.length < 5000) return;
      captured = {
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData(),
        responseBytes: body.length,
        // Keep a slice so `prove` can build a responseMatch it knows is present.
        sample: body.slice(0, 400),
        status: res.status(),
        contentType: res.headers()["content-type"] ?? "",
      };
    } catch {
      /* body already consumed */
    }
  });

  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".hit", { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const cookies = await ctx.cookies();
  await browser.close();

  if (!captured) {
    console.log("FAILED: never saw the answer-bearing request.");
    process.exit(1);
  }

  captured.cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  writeFileSync(CAPTURE_FILE, JSON.stringify(captured, null, 2));

  console.log(`url            ${captured.url}`);
  console.log(`method         ${captured.method}`);
  console.log(`status         ${captured.status}`);
  console.log(`content-type   ${captured.contentType}`);
  console.log(`response       ${captured.responseBytes} bytes`);
  console.log(`request body   ${captured.postData ? `${captured.postData.length} bytes` : "(none)"}`);
  console.log(`cookies        ${cookies.length} (${captured.cookieStr.length} chars)`);
  console.log(`headers        ${Object.keys(captured.headers).join(", ")}`);
  console.log(`\nsaved to ${CAPTURE_FILE}`);
  console.log(`\nnext: node scripts/spike-zktls.mjs prove`);
}

// ── stage 2: ask an attestor to witness the same request ──────────────────────
async function prove() {
  if (!existsSync(CAPTURE_FILE)) {
    console.log(`no capture found — run \`node scripts/spike-zktls.mjs capture\` first`);
    process.exit(1);
  }
  const cap = JSON.parse(readFileSync(CAPTURE_FILE, "utf8"));

  const ownerPrivateKey = process.env.ZKTLS_OWNER_KEY;
  if (!ownerPrivateKey) {
    console.log("set ZKTLS_OWNER_KEY in .env — any 0x-prefixed 32-byte hex will do;");
    console.log("it identifies the proof's owner and is unrelated to the Hedera keys.");
    process.exit(2);
  }

  await installTlsCrypto();
  const zkOperators = await makeZkOperators();

  const { createClaimOnAttestor } = await import("@reclaimprotocol/attestor-core");

  // Match on something we know the real response contains, so a proof that succeeds
  // against different bytes is not silently accepted.
  const needle = (cap.sample.match(/"[a-zA-Z_]{4,20}"\s*:/g) ?? [])[1]?.replace(/\s*:$/, "");
  if (!needle) {
    console.log("could not derive a response match from the captured sample");
    process.exit(1);
  }
  console.log(`matching on   ${needle}`);

  // Public headers are ones the attestor may see: content negotiation only.
  const headers = {};
  for (const k of ["content-type", "accept", "user-agent", "referer"]) {
    if (cap.headers[k]) headers[k] = cap.headers[k];
  }

  // Credentials go in secretParams, which the attestor never sees. The Virgo SPA sends a
  // bearer token it fetched at load; without it the request 401s, and putting it in the
  // public headers would hand a live credential to a third party.
  const secretHeaders = {};
  for (const k of ["authorization", "cookie"]) {
    if (cap.headers[k]) secretHeaders[k] = cap.headers[k];
  }
  console.log(
    `public headers ${Object.keys(headers).join(", ")}`,
  );
  console.log(
    `secret headers ${Object.keys(secretHeaders).join(", ") || "(none)"}${cap.cookieStr ? " + cookies" : ""}`,
  );

  const t0 = Date.now();
  console.log(`\nasking attestor to witness ${cap.method} ${new URL(cap.url).host} ...`);

  try {
    const result = await createClaimOnAttestor({
      name: "http",
      params: {
        url: cap.url,
        method: cap.method,
        headers,
        ...(cap.postData ? { body: cap.postData } : {}),
        responseMatches: [{ type: "contains", value: needle }],
      },
      secretParams: {
        ...(cap.cookieStr ? { cookieStr: cap.cookieStr } : {}),
        ...(Object.keys(secretHeaders).length ? { headers: secretHeaders } : {}),
      },
      ownerPrivateKey,
      zkOperators,
      client: { url: "wss://attestor.reclaimprotocol.org:444/ws" },
      onStep: (step) => console.log(`  step        ${step.name}`),
    });

    const elapsed = Date.now() - t0;

    if (result.error) {
      console.log(`\nATTESTOR REFUSED after ${elapsed}ms`);
      console.log(JSON.stringify(result.error, null, 2).slice(0, 1200));
      process.exit(1);
    }

    console.log(`\nPROOF OBTAINED in ${elapsed}ms`);
    console.log(`identifier    ${result.claim?.identifier}`);
    console.log(`owner         ${result.claim?.owner}`);
    console.log(`timestamp     ${result.claim?.timestampS}`);
    // `signatures` is an object, not an array — reading `.length` off it prints 0 and
    // makes a signed claim look unsigned. Report the attestor that actually signed.
    console.log(`attestor      ${result.signatures?.attestorAddress ?? "(none)"}`);
    console.log(`proof size    ${JSON.stringify(result).length} bytes`);

    writeFileSync(PROOF_FILE, JSON.stringify(result, null, 2));
    console.log(`proof saved to ${PROOF_FILE}`);
    console.log(`\nnext: node scripts/spike-zktls.mjs check`);
  } catch (err) {
    console.log(`\nFAILED after ${Date.now() - t0}ms`);
    console.log(String(err?.message ?? err).slice(0, 400));
    console.log("\n--- stack ---");
    console.log(String(err?.stack ?? "(none)").split("\n").slice(0, 12).join("\n"));
    process.exit(1);
  }
}

// ── stage 3: try to break the proof ───────────────────────────────────────────
/**
 * A signature check that has never been seen to fail proves nothing.
 *
 * `assertValidClaimSignatures` returning quietly is only evidence if the same call throws
 * on a proof that has been tampered with. So this stage verifies the real proof, then
 * corrupts it three different ways and requires a rejection each time.
 */
async function check() {
  if (!existsSync(PROOF_FILE)) {
    console.log(`no proof found — run \`node scripts/spike-zktls.mjs prove\` first`);
    process.exit(1);
  }
  const proof = JSON.parse(readFileSync(PROOF_FILE, "utf8"));

  await installTlsCrypto();
  const { assertValidClaimSignatures } = await import("@reclaimprotocol/attestor-core");

  /**
   * Put the byte arrays back.
   *
   * JSON has no Uint8Array, so every one of them — five, scattered through the proof and
   * the request that produced it — round-trips as an object keyed by byte index. Reviving
   * only the obvious one leaves the rest as plain objects, and the signature check then
   * fails while *encoding* the claim, before it ever looks at the signature. That failure
   * is indistinguishable from a rejection, which would make a tamper test pass for the
   * wrong reason: every mutation "rejected", including no mutation at all.
   */
  const revive = (node) => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(revive);
    const keys = Object.keys(node);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return Uint8Array.from(keys.map((k) => node[k]));
    }
    return Object.fromEntries(keys.map((k) => [k, revive(node[k])]));
  };

  const params = JSON.parse(proof.claim.parameters);
  console.log(`witnessed     ${params.method} ${params.url}`);
  console.log(`matched on    ${JSON.stringify(params.responseMatches)}`);
  console.log(`attestor      ${proof.signatures.attestorAddress}`);
  console.log(`owner         ${proof.claim.owner}`);
  console.log(
    `signed at     ${new Date(proof.claim.timestampS * 1000).toISOString()}\n`,
  );

  let failures = 0;
  const expect = async (label, mutate, shouldPass) => {
    const subject = revive(structuredClone(proof));
    mutate(subject);
    let threw = null;
    try {
      await assertValidClaimSignatures(subject);
    } catch (err) {
      threw = err;
    }
    const ok = shouldPass ? threw === null : threw !== null;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${threw ? `rejected: ${String(threw.message).slice(0, 60)}` : "accepted"}`,
    );
  };

  await expect("the untouched proof is accepted", () => {}, true);
  await expect(
    "one flipped bit in the signature is rejected",
    (p) => (p.signatures.claimSignature[8] ^= 1),
    false,
  );
  await expect(
    "a re-pointed URL is rejected",
    (p) => {
      const q = JSON.parse(p.claim.parameters);
      q.url = q.url.replace("/api/search", "/api/search2");
      p.claim.parameters = JSON.stringify(q);
    },
    false,
  );
  await expect(
    "claiming someone else's response is rejected",
    (p) => (p.claim.identifier = `0x${"0".repeat(64)}`),
    false,
  );
  await expect(
    "a re-owned claim is rejected",
    (p) => (p.claim.owner = "0x0000000000000000000000000000000000000001"),
    false,
  );

  // The credentials were sent through the tunnel but must never appear in the artifact
  // we would hand a buyer, or the proof would be a way to leak a live session.
  const text = JSON.stringify(proof).toLowerCase();
  const leaked = ["bearer", "authorization", "cookie"].filter((k) => text.includes(k));
  console.log(
    `  ${leaked.length === 0 ? "PASS" : "FAIL"}  ${"no credential appears in the proof".padEnd(46)} ${leaked.length ? `leaked: ${leaked.join(", ")}` : "clean"}`,
  );
  if (leaked.length) failures++;

  console.log(failures === 0 ? `\nall checks held.` : `\n${failures} CHECK(S) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

if (STAGE === "capture") await capture();
else if (STAGE === "prove") await prove();
else if (STAGE === "check") await check();
else {
  console.log("usage: node scripts/spike-zktls.mjs [capture|prove|check]");
  process.exit(2);
}
