/**
 * Capture the README's screenshots from the live services.
 *
 * Scripted rather than taken by hand so they can be retaken after a redesign, and so a
 * reader can check that the pictures in the README are of the real thing rather than a
 * mock-up. Every shot is of a deployed URL; nothing here runs a local build.
 *
 * The two verification shots need a receipt and the result file that produced it, which
 * is the point of them — one shows a receipt that checks out, the other the same receipt
 * with one character of the result changed.
 *
 *   node scripts/screenshots.mjs
 *
 * Takes about a minute. Output lands in docs/screenshots/ and is committed.
 */
import { mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "docs", "screenshots");
mkdirSync(out, { recursive: true });

const WEB = process.env.WEB_URL ?? "https://web-production-187614.up.railway.app";
const SELLER = process.env.SELLER_URL ?? "https://seller-production-d5ab.up.railway.app";
const VERIFIER = process.env.VERIFIER_URL ?? "https://verifier-production-0199.up.railway.app";

/**
 * The receipt the README is shot against.
 *
 * Seq 18 deliberately: it is an `oracle.capture_claim` job, so it carries a zkTLS
 * retrieval proof as well as the page and screenshot. That is the only kind of receipt
 * where every one of the thirteen checks has something to check, and a screenshot of
 * thirteen green rows is worth more than one with an honest "not checked" in it.
 */
const RECEIPT = { topic: "0.0.10413059", seq: "18", submitter: "0.0.10410493" };
const RESULT = "result-proof.json";
const ARTIFACTS = ["result-proof.page.html", "result-proof.screenshot.png", "result-proof.proof.json"];
const CAPABILITY = "oracle.capture_claim";
const TAMPERED = "result-proof.tampered.json";

/**
 * Captured at the width a README actually renders at.
 *
 * GitHub caps content around 900px, so a 2560px screenshot costs a reader megabytes to
 * see the same pixels. `scale: "css"` takes the shot at CSS pixels rather than device
 * pixels, so the file is 1440 wide however the viewport is scaled.
 */
async function shot(page, name, { fullPage = false } = {}) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage, scale: "css" });
  console.log(`  ${name}.png`.padEnd(30), `${(statSync(file).size / 1024).toFixed(0)} KB`);
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

// Motion settles before the shutter, or the hero is caught mid-fade.
const settle = async (ms = 2500) => page.waitForTimeout(ms);

console.log("capturing:");

// ── 1. the landing page ────────────────────────────────────────────────────────
await page.goto(WEB, { waitUntil: "networkidle" });
await settle(3500);
await shot(page, "01-hero");

// ── 2. the catalogue, which is the "service you can pay for" ───────────────────
await page.goto(`${WEB}/#capabilities`, { waitUntil: "networkidle" });
await settle(2000);
await shot(page, "02-capabilities");

// ── 3. the seller's own manifest, rendered for a person ────────────────────────
await page.goto(SELLER, { waitUntil: "networkidle" });
await settle(1200);
await shot(page, "03-seller-manifest");

// ── 4 & 5. verification, both verdicts ─────────────────────────────────────────
async function verify(resultFile, name, { artifacts = [], capability = "" } = {}) {
  await page.goto(VERIFIER, { waitUntil: "networkidle" });
  await page.fill("#topic", RECEIPT.topic);
  await page.fill("#seq", RECEIPT.seq);
  await page.fill("#submitter", RECEIPT.submitter);
  await page.setInputFiles("#result", join(root, resultFile));
  // The artifacts and the capability are what turn "not checked" into a real answer.
  // Without them the page is honest and says so, which is the right default and a poor
  // advertisement — the README wants the shot where everything that can be checked was.
  if (artifacts.length) {
    await page.setInputFiles("#artifacts", artifacts.map((f) => join(root, f)));
  }
  if (capability) await page.selectOption("#capability", capability);
  await page.click("#go");
  // The checks stamp in one at a time and the verdict lands after the last one.
  await page.waitForSelector(".stamp.show", { timeout: 30_000 });
  await settle(1200);
  await page.locator("#result-panel").scrollIntoViewIfNeeded();
  await settle(600);
  await shot(page, name, { fullPage: true });
}

if (existsSync(join(root, RESULT))) {
  await verify(RESULT, "04-verified", { artifacts: ARTIFACTS, capability: CAPABILITY });
  // The same receipt and the same artifacts, with one character of the result changed.
  // Everything that is not the result stays green, which is the point being made.
  await verify(TAMPERED, "05-void", { artifacts: ARTIFACTS, capability: CAPABILITY });
} else {
  console.log(`  (skipped verification shots — no ${RESULT} in the repo root)`);
}

await browser.close();
console.log(`\nwritten to docs/screenshots/`);
