/**
 * Run the whole thing as two buyers who are not us.
 *
 * The project's honest weakness has been that every receipt on the topic was paid for by
 * one account, and that account was the seller's author. A system nobody else has used is
 * a demonstration, not evidence.
 *
 * So this is an acceptance run against the deployed service, from two separate Hedera
 * accounts with their own keys, covering the paths that matter — including the ones where
 * the right outcome is that **no money moves**:
 *
 *   1. Buyer A buys through the CLI and verifies the receipt.
 *   2. Buyer B discovers the service in the on-chain directory, negotiates a budget,
 *      pays, and verifies.
 *   3. A source the site's robots.txt disallows is refused before a quote exists.
 *   4. A capture that matches nothing is refused after the work, and charges zero.
 *   5. An address that resolves somewhere private is refused outright.
 *
 * Balances are read before and after and reconciled against what the receipts claim. That
 * reconciliation is the point: a test that only checks the happy path cannot tell you
 * whether the refusals were free or merely quiet.
 *
 * Keys travel from the file into the child process through the environment — never argv,
 * which is visible in a process list, and never stdout. Nothing here prints one.
 *
 *   node scripts/two-buyers.mjs <path-to-accounts.txt> [--only a|b]
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

/**
 * Where the accounts file lives, from the caller rather than from here.
 *
 * No default. A committed script that points at one machine's Downloads folder is both
 * useless to anyone else and a standing invitation to leave credentials somewhere
 * predictable; making it required costs one argument and removes both.
 */
const positional = process.argv
  .slice(2)
  .filter((v, i, all) => !v.startsWith("--") && all[i - 1] !== "--only");
const FILE = positional[0] ?? process.env.ACCOUNTS_FILE;
if (!FILE) {
  console.error(
    [
      "usage: node scripts/two-buyers.mjs <accounts-file> [--only a|b]",
      "",
      "The file holds two funded testnet accounts, as:",
      "  Account_ID=0.0.x",
      "  private_key=0x…",
      "",
      "Keep it outside the repository. Nothing here prints a key.",
    ].join("\n"),
  );
  process.exit(2);
}

const SELLER = process.env.SELLER_URL ?? "https://seller-production-d5ab.up.railway.app";
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";

/** Pull `Account_ID` / `private_key` pairs in the order they appear. */
function readAccounts(path) {
  const text = readFileSync(path, "utf8");
  const accounts = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/Account_ID\s*=\s*(0\.0\.\d+)/i);
    const key = line.match(/private_key\s*=\s*(0x[0-9a-fA-F]{64})/i);
    if (id) {
      current = { accountId: id[1] };
      accounts.push(current);
    } else if (key && current) {
      current.privateKey = key[1];
    }
  }
  const usable = accounts.filter((a) => a.accountId && a.privateKey);
  if (usable.length < 2) throw new Error(`need two accounts with keys, found ${usable.length}`);
  return usable;
}

/** Run a command with a buyer's credentials in the environment, streaming its output. */
function run(command, args, account, label) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        SELLER_URL: SELLER,
        BUYER_ACCOUNT_ID: account.accountId,
        BUYER_PRIVATE_KEY: account.privateKey,
        HEDERA_NETWORK: "testnet",
      },
      shell: process.platform === "win32",
    });
    let out = "";
    const keep = (chunk) => {
      const text = chunk.toString();
      out += text;
      const shown = text
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("> ") && !l.includes("ELIFECYCLE"))
        .map((l) => `  ${label} │ ${l}`)
        .join("\n");
      if (shown) process.stdout.write(shown + "\n");
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const balance = async (id) =>
  BigInt((await fetch(`${MIRROR}/accounts/${id}`).then((x) => x.json())).balance?.balance ?? 0);

/** Ask for a quote directly, to exercise refusals that never reach a payment. */
async function quote(capability, params) {
  const res = await fetch(`${SELLER}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, params }),
  });
  return { status: res.status, body: await res.json() };
}

const rule = (t) => console.log(`\n${`── ${t} `.padEnd(78, "─")}`);
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
const [a, b] = readAccounts(FILE);

console.log(`Buyer A  ${a.accountId}`);
console.log(`Buyer B  ${b.accountId}`);
console.log(`Seller   ${SELLER}`);

const before = { a: await balance(a.accountId), b: await balance(b.accountId) };

// ── 1. Buyer A, the ordinary route ────────────────────────────────────────────
let resultA = { code: 0, out: "" };
if (only !== "b") {
  rule("1. Buyer A — quote, 402, pay, verify");
  resultA = await run(
    "pnpm",
    [
      "buy",
      "--capability",
      "oracle.capture_claim",
      "--param",
      "url=https://www.whitehouse.gov/presidential-actions/",
      "--param",
      "select=.wp-block-post-title",
      "--param",
      "max=3",
      "--out",
      "./buyer-a.json",
    ],
    a,
    "A",
  );
  check("Buyer A completed a paid job", resultA.code === 0);
}

// ── 2. Buyer B, discovery and negotiation ─────────────────────────────────────
let resultB = { code: 0, out: "" };
if (only !== "a") {
  rule("2. Buyer B — read the directory, negotiate a budget, pay, verify");
  resultB = await run("pnpm", ["agent", "--need", "quotes", "--budget", "400000"], b, "B");
  check("Buyer B negotiated and paid", resultB.code === 0);
  check(
    "Buyer B was offered less work rather than a discount",
    /same published rate, less work/.test(resultB.out),
  );
  check(
    "Buyer B re-priced the counter-offer against the published book",
    /counter-offer is at the published rate/.test(resultB.out),
  );
}

// ── 3. A source the site itself disallows ─────────────────────────────────────
rule("3. A source robots.txt disallows — refused before a price exists");
const disallowed = await quote("oracle.capture_claim", {
  url: "https://www.federalregister.gov/documents/search?q=x",
  select: "h1",
  max: 1,
});
console.log(`  seller │ ${disallowed.status} ${disallowed.body.message ?? ""}`.trim());
check(
  "refused at quote time, quoting the rule",
  disallowed.status === 400 && /robots\.txt/.test(disallowed.body.message ?? ""),
);

// ── 4. An address that is not ours to read ────────────────────────────────────
rule("4. An address that resolves somewhere private — refused outright");
for (const url of [
  "https://169.254.169.254/latest/meta-data/",
  "https://localhost/admin",
  "https://[::ffff:127.0.0.1]/x",
]) {
  const r = await quote("oracle.capture_claim", { url, select: "h1", max: 1 });
  const refused = r.status === 400;
  console.log(`  seller │ ${url}`);
  console.log(`         │ ${r.status} ${(r.body.message ?? "").slice(0, 96)}`);
  check(`refused ${new URL(url).hostname}`, refused);
}

// ── 5. A capture that matches nothing ─────────────────────────────────────────
let zero = { code: 0, out: "" };
if (only !== "b") {
  rule("5. A capture that matches nothing — charges zero");
  zero = await run(
    "pnpm",
    [
      "buy",
      "--capability",
      "oracle.capture_claim",
      "--param",
      "url=https://www.whitehouse.gov/presidential-actions/",
      // A selector no page carries, standing in for a bot challenge or a redesign: the
      // browser loads something, and none of it is what was asked for.
      "--param",
      "select=.definitely-not-on-this-page",
      "--param",
      "max=1",
      "--out",
      "./buyer-a-empty.json",
    ],
    a,
    "A",
  );
  check("the job was refused rather than billed", zero.code !== 0);
  check("the buyer was told nothing was charged", /Nothing was charged/.test(zero.out));
  check("a receipt was published anyway", /receipt was still published/.test(zero.out));
}

// ── the reckoning ─────────────────────────────────────────────────────────────
await new Promise((r) => setTimeout(r, 8000)); // mirror node lag
const after = { a: await balance(a.accountId), b: await balance(b.accountId) };

rule("what each buyer actually spent");
const spentA = before.a - after.a;
const spentB = before.b - after.b;
console.log(`  Buyer A  ${a.accountId}  ${spentA} tinybar`);
console.log(`  Buyer B  ${b.accountId}  ${spentB} tinybar`);

if (only !== "b") {
  // One paid job at 321,000 and one refusal at nothing. Anything more means the empty
  // capture was billed after all, which is the whole point of step 5.
  check("Buyer A paid for exactly one job", spentA === 321000n, `${spentA} tinybar`);
}
if (only !== "a") {
  check("Buyer B paid the negotiated price", spentB === 312000n, `${spentB} tinybar`);
}

rule("result");
const failed = checks.filter((c) => !c.pass);
console.log(`  ${checks.length - failed.length}/${checks.length} checks passed`);
for (const f of failed) console.log(`  FAILED: ${f.name}`);
process.exit(failed.length ? 1 : 0);
