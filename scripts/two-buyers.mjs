/**
 * Run the whole thing as two buyers who are not us.
 *
 * The project's honest weakness has been that every receipt on the topic was paid for by
 * one account, and that account was the seller's author. A system nobody else has used is
 * a demonstration, not evidence. These are two separate Hedera accounts with their own
 * keys, buying through the two routes a real buyer would take:
 *
 *   Buyer A — the ordinary path: quote, 402, pay, verify.
 *   Buyer B — the agent path: state a budget, negotiate scope, accept, pay, verify.
 *
 * Keys are read from a file and passed to the child process through the environment.
 * Nothing here prints one, and the file is never read into anything that gets committed.
 *
 *   node scripts/two-buyers.mjs [path-to-accounts.txt]
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

/** First bare argument is the accounts file; flags are not it. */
const positional = process.argv.slice(2).filter((v, i, all) => !v.startsWith("--") && all[i - 1] !== "--only");
const FILE = positional[0] ?? "C:/Users/aryan/Downloads/test_Accounts.txt";
const SELLER = process.env.SELLER_URL ?? "https://seller-production-d5ab.up.railway.app";

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
      // The key travels in the environment and nowhere else — never argv, which is
      // visible in a process list, and never stdout.
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
      process.stdout.write(
        text
          .split("\n")
          .map((l) => (l.trim() ? `  ${label} │ ${l}` : ""))
          .filter(Boolean)
          .join("\n") + "\n",
      );
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const balance = async (id) => {
  const r = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${id}`).then((x) =>
    x.json(),
  );
  return BigInt(r.balance?.balance ?? 0);
};

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const [a, b] = readAccounts(FILE);
console.log(`Buyer A  ${a.accountId}`);
console.log(`Buyer B  ${b.accountId}`);
console.log(`Seller   ${SELLER}\n`);

const before = { a: await balance(a.accountId), b: await balance(b.accountId) };

// ── Buyer A: the ordinary route ───────────────────────────────────────────────
console.log("── Buyer A — quote, 402, pay, verify ".padEnd(78, "─"));
const resultA = only === "b" ? { code: 0 } : await run(
  "pnpm",
  [
    "buy",
    "--capability",
    "oracle.capture_claim",
    "--param",
    // whitehouse.gov rather than federalregister.gov/documents/current, which the first
    // run of this script chose and which that site disallows in robots.txt — the policy
    // refused it correctly, before a quote existed and before anyone was charged.
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

// ── Buyer B: the negotiating agent ────────────────────────────────────────────
console.log(`\n${"── Buyer B — discover, negotiate a budget, pay, verify ".padEnd(78, "─")}`);
const resultB = only === "a" ? { code: 0 } : await run(
  "pnpm",
  ["agent", "--need", "quotes", "--budget", "400000"],
  b,
  "B",
);

const after = { a: await balance(a.accountId), b: await balance(b.accountId) };

console.log(`\n${"── what each buyer actually spent ".padEnd(78, "─")}`);
for (const [label, acct, was, now] of [
  ["A", a.accountId, before.a, after.a],
  ["B", b.accountId, before.b, after.b],
]) {
  const spent = was - now;
  console.log(`  Buyer ${label}  ${acct}  spent ${spent} tinybar`);
}

console.log(
  `\nexit codes: A=${resultA.code} B=${resultB.code}`,
);
