/**
 * Deploy the whole thing to Railway in one command.
 *
 *   pnpm deploy:railway
 *   pnpm deploy:railway -- --dry-run    # print every change, make none
 *
 * Not `pnpm deploy`: pnpm reserves that name for its own workspace-deploy command, which
 * shadows anything of that name in package.json and fails with ERR_PNPM_NOTHING_TO_DEPLOY.
 *
 * Safe to run repeatedly. Every step checks whether it has already been done, so a
 * re-run after a failure picks up where it stopped rather than creating a second copy
 * of everything — which matters here, because Railway will happily give you two services
 * called `seller` and only one of them will have the volume.
 *
 * ── About the keys ──────────────────────────────────────────────────────────────
 * This reads `.env` from your machine and sets the seller's variables from it, including
 * `SELLER_PRIVATE_KEY`. That is the one step that has to be you rather than an assistant,
 * which is the whole reason this file exists as a script you run. Values are never
 * printed — secrets are shown as `set (hidden)` and nothing else.
 *
 * ── What it will not do ─────────────────────────────────────────────────────────
 * It does not deploy `apps/wallet`. That service holds a funded key and the demo works
 * without it: visitors connect their own wallet instead. See railway.wallet.toml if you
 * decide otherwise, and read it before you do.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PROJECT = "ledger-of-work";

/**
 * Print what would change and change nothing.
 *
 * Worth having for its own sake — this script sets a private key on a third-party host
 * and builds a 2GB image, and being able to read exactly what it will do first is not a
 * luxury. Read-only calls still run, so the output reflects the real state of the account
 * rather than a guess at it.
 */
const DRY = process.argv.includes("--dry-run");

/** Everything a service needs, and which of those must never be echoed. */
const SERVICES = {
  verifier: {
    dockerfile: "Dockerfile.verify",
    port: 8405,
    public: true,
    vars: () => ({ VERIFY_PORT: "8405" }),
    describe: "the receipt verifier — static, no keys, no backend",
  },
  seller: {
    dockerfile: "Dockerfile",
    port: 8402,
    public: true,
    volume: "/app/.data",
    required: ["SELLER_ACCOUNT_ID", "SELLER_PRIVATE_KEY", "SELLER_TOPIC_ID"],
    vars: (env) => ({
      PORT: "8402",
      QUOTE_STORE_PATH: "/app/.data/quotes.json",
      ...pick(env, [
        "SELLER_ACCOUNT_ID",
        "SELLER_PRIVATE_KEY",
        "SELLER_TOPIC_ID",
        "FACILITATOR_URL",
        "FACILITATOR_API_KEY",
        "X402_NETWORK",
        "PAYMENT_TOKEN_ID",
        "PAYMENT_TOKEN_SYMBOL",
        "PAYMENT_TOKEN_DECIMALS",
        "PAYMENT_TOKEN_RATE",
        "AGENT_CARD_FILE_ID",
        "FEEDBACK_TOPIC_ID",
        "ZKTLS_OWNER_KEY",
      ]),
    }),
    describe: "the x402 seller — drives a real browser, holds the seller's key",
  },
  web: {
    dockerfile: "Dockerfile.web",
    port: 8403,
    public: true,
    // Reaches the seller over Railway's private network rather than back out through
    // the internet — cheaper, faster, and it keeps the hop off the public web.
    vars: (env) => ({
      PORT: "8403",
      SELLER_URL: "http://seller.railway.internal:8402",
      ...pick(env, ["SELLER_ACCOUNT_ID", "MIRROR_NODE_URL"]),
    }),
    describe: "the demo UI — holds no key; visitors connect their own wallet",
  },
};

/**
 * Anything matching this is never printed, only counted.
 *
 * Matched on the *shape* of the name rather than a list, because a list is a thing you
 * forget to update. The first version of this named `PRIVATE_KEY` and friends explicitly
 * and printed `ZKTLS_OWNER_KEY` in full to the terminal on its first run — a private key,
 * echoed by the script whose entire premise is that it handles them carefully.
 *
 * `_KEY$` and `_TOKEN$` are anchored so the public `PAYMENT_TOKEN_ID` and
 * `PAYMENT_TOKEN_SYMBOL` stay readable; a redacted deploy log helps nobody either.
 */
const SECRET = /(_KEY$|PRIVATE|SECRET|PASSWORD|MNEMONIC|_TOKEN$)/i;

const pick = (env, keys) =>
  Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]]));

// ── plumbing ──────────────────────────────────────────────────────────────────
const c = { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", bold: "\x1b[1m", off: "\x1b[0m" };
const say = (s = "") => console.log(s);
const step = (s) => say(`\n${c.bold}${s}${c.off}`);
const ok = (s) => say(`  ${c.green}OK${c.off}   ${s}`);
const info = (s) => say(`  ${c.dim}·${c.off}    ${s}`);
const die = (s) => {
  say(`\n${c.red}${s}${c.off}`);
  process.exit(1);
};

/**
 * Find the Railway CLI, and work out how it can actually be launched.
 *
 * Two Windows traps, both of which look identical to "the CLI is not installed":
 *
 *   - `execFileSync` does not apply PATHEXT, so a bare `railway` fails to spawn even
 *     when `railway.exe` is on PATH.
 *   - installed via npm, `railway` is a `.cmd` shim, and Node 20+ refuses to execFile
 *     `.cmd` without a shell (CVE-2024-27980). That surfaces as EINVAL.
 *
 * So: try to spawn something directly, and only fall back to a shell if nothing works.
 * Direct is preferred because a shell re-parses the command line, and these arguments
 * carry `=`, `/` and `:`.
 */
function findRailway() {
  const direct =
    process.platform === "win32" ? ["railway.exe", "railway", "railway.cmd"] : ["railway"];
  for (const bin of direct) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return { bin, shell: false };
    } catch {
      /* next */
    }
  }
  // Last resort: let the shell resolve it. Arguments get quoted at the call site.
  try {
    execFileSync("railway", ["--version"], { stdio: "ignore", shell: true });
    return { bin: "railway", shell: true };
  } catch {
    return null;
  }
}

const CLI = findRailway();
const BIN = CLI?.bin;

/**
 * Run the Railway CLI.
 *
 * `execFileSync` rather than a shell string on purpose: arguments carrying `=` and `/`
 * go through untouched. Running this under Git Bash on Windows otherwise rewrites
 * `/app/.data/quotes.json` into `C:/Program Files/Git/app/...`, which fails much later
 * as a quote store that silently does not persist.
 */
function railway(args, { capture = true, quiet = false, mutates = false } = {}) {
  if (mutates && DRY) {
    const redacted = args.map((a) =>
      SECRET.test(a.split("=")[0] ?? "") ? `${a.split("=")[0]}=<hidden>` : a,
    );
    say(`  ${c.dim}would run:${c.off} railway ${redacted.join(" ")}`);
    return "";
  }
  try {
    // Under a shell the command line is re-parsed, so each argument is quoted. None of
    // ours contain a double quote; the values are ids, URLs, paths and hex.
    const passed = CLI.shell ? args.map((a) => (/^[\w.:/@=-]+$/.test(a) ? a : `"${a}"`)) : args;
    const out = execFileSync(BIN, passed, {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      // MSYS_NO_PATHCONV stops Git Bash rewriting `/app/.data` into a Windows path.
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
      shell: CLI.shell,
      maxBuffer: 64 * 1024 * 1024,
    });
    return out ?? "";
  } catch (err) {
    if (!quiet) {
      const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
      die(`railway ${args.slice(0, 3).join(" ")} failed:\n${detail.slice(0, 900)}`);
    }
    throw err;
  }
}

/** Parse a .env without pulling in a dependency, and without evaluating anything. */
function readEnv(path) {
  if (!existsSync(path)) die(`no ${path} — copy .env.example and fill it in first.`);
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

// ── preflight ─────────────────────────────────────────────────────────────────
say(`${c.bold}Deploying ${PROJECT} to Railway${c.off}`);

step("Checking the CLI");
if (!BIN) {
  die("The Railway CLI is not installed, or not on PATH.\n  npm i -g @railway/cli   (then: railway login)");
}
ok(`${BIN} ${railway(["--version"], { quiet: true }).trim()}`);
let who;
try {
  who = railway(["whoami"], { quiet: true }).trim();
} catch {
  die("Not logged in to Railway.\n  Run: railway login");
}
ok(who);

step("Reading .env");
const env = readEnv(".env");
const missing = [...new Set(Object.values(SERVICES).flatMap((s) => s.required ?? []))].filter(
  (k) => !env[k],
);
if (missing.length) die(`.env is missing: ${missing.join(", ")}`);
ok(`${Object.keys(env).length} values, ${Object.keys(env).filter((k) => SECRET.test(k)).length} of them secret`);

// ── project ───────────────────────────────────────────────────────────────────
step("Project");
let status = null;
try {
  status = JSON.parse(railway(["status", "--json"], { quiet: true }));
} catch {
  /* not linked in this directory yet */
}

// The CLI links a project *per directory*, and that link does not survive a fresh
// `railway login` — nor does it follow you from one shell to another if the paths differ
// in case. Both look identical from here: "No linked project found". So if the project
// already exists on the account, link to it rather than telling someone to go and do it.
if (!status?.name) {
  const known = railway(["list"], { quiet: true });
  if (known.includes(PROJECT)) {
    info(`not linked here — linking to the existing "${PROJECT}"`);
    railway(["link", "-p", PROJECT, "-e", "production"], { quiet: true, mutates: true });
    if (!DRY) {
      try {
        status = JSON.parse(railway(["status", "--json"], { quiet: true }));
      } catch {
        die(`could not link to "${PROJECT}". Run: railway link -p ${PROJECT}`);
      }
    }
  }
}

if (status?.name) {
  ok(`linked to "${status.name}"`);
} else {
  info(`creating "${PROJECT}"`);
  try {
    railway(["init", "-n", PROJECT], { quiet: true, mutates: true });
  } catch (err) {
    const msg = (err.stderr || err.stdout || "").toString();
    if (/limit exceeded/i.test(msg)) {
      die(
        "Railway refused: free plan resource limit exceeded.\n" +
          "  Upgrade the plan, or free capacity in another project, then re-run this.",
      );
    }
    die(`could not create the project:\n${msg.slice(0, 600)}`);
  }
  if (DRY) {
    status = { name: PROJECT, services: { edges: [] } };
    ok(`would create "${PROJECT}"`);
  } else {
    status = JSON.parse(railway(["status", "--json"]));
    ok(`created "${status.name}"`);
  }
}

const existing = new Set((status.services?.edges ?? []).map((e) => e.node?.name).filter(Boolean));

// ── services ──────────────────────────────────────────────────────────────────
for (const [name, spec] of Object.entries(SERVICES)) {
  step(`Service: ${name}`);
  info(spec.describe);

  const vars = { RAILWAY_DOCKERFILE_PATH: spec.dockerfile, ...spec.vars(env) };

  if (existing.has(name)) {
    ok("exists — updating variables");
    for (const [k, v] of Object.entries(vars)) {
      railway(["variables", "--service", name, "--set", `${k}=${v}`, "--skip-deploys"], {
        mutates: true,
      });
    }
  } else {
    const args = ["add", "-s", name];
    for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
    railway(args, { mutates: true });
    ok(DRY ? "would create" : "created");
  }
  const shown = Object.keys(vars).map((k) => (SECRET.test(k) ? `${k}=set (hidden)` : k));
  info(`variables: ${shown.join(", ")}`);

  // A volume has to be attached before the first deploy, or the first run writes its
  // quote store to a filesystem that disappears with the container.
  if (spec.volume) {
    const volumes = JSON.parse(railway(["volume", "list", "--json"], { quiet: true }) || "[]");
    const list = Array.isArray(volumes) ? volumes : (volumes.volumes ?? []);
    if (list.some((v) => v.serviceName === name)) {
      ok(`volume already attached at ${spec.volume}`);
    } else {
      railway(["service", name], { mutates: true });
      railway(["volume", "add", "-m", spec.volume], { mutates: true });
      ok(`${DRY ? "would create volume" : "volume created"} at ${spec.volume}`);
    }
  }
}

// ── deploy ────────────────────────────────────────────────────────────────────
// The seller carries a browser and takes several minutes; the other two are quick.
for (const [name, spec] of Object.entries(SERVICES)) {
  step(`Deploying ${name}`);
  if (name === "seller") info("this one carries a browser: ~2GB image, several minutes");
  try {
    railway(["up", "--service", name, "--ci"], { capture: false, mutates: true });
    ok(DRY ? "would deploy" : "deployed");
  } catch {
    die(
      `${name} failed to deploy.\n` +
        `  railway logs --service ${name} --build\n` +
        `  railway logs --service ${name} --deployment`,
    );
  }

  if (spec.public) {
    const domains = railway(["domain", "--service", name, "--port", String(spec.port)], {
      quiet: true,
      mutates: true,
    });
    const url = (domains.match(/https:\/\/[^\s]+/) ?? [])[0];
    if (url) ok(url);
  }
}

// ── check ─────────────────────────────────────────────────────────────────────
step("Checking the deployed services");
if (DRY) info("skipped — nothing was deployed");
const urls = {};
for (const name of Object.keys(SERVICES)) {
  const out = railway(["variables", "--service", name, "--kv"], { quiet: true });
  const domain = (out.match(/RAILWAY_PUBLIC_DOMAIN=(\S+)/) ?? [])[1];
  if (domain) urls[name] = `https://${domain}`;
}

for (const [name, url] of Object.entries(DRY ? {} : urls)) {
  const path = name === "seller" ? "/health" : "/";
  let code = 0;
  // Containers take a moment to come up behind the edge; a single probe would report a
  // healthy service as broken.
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(url + path, { signal: AbortSignal.timeout(15000) });
      code = res.status;
      if (code === 200) break;
    } catch {
      code = 0;
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
  if (code === 200) ok(`${name.padEnd(9)} ${url}`);
  else say(`  ${c.red}??${c.off}   ${name.padEnd(9)} ${url}  (HTTP ${code || "no response"})`);
}

say(`
${c.bold}Done.${c.off}

  Verifier   ${urls.verifier ?? "—"}
  Demo UI    ${urls.web ?? "—"}
  Seller     ${urls.seller ?? "—"}

${c.dim}Two things this script cannot set, because they live in the dashboard:

  1. Config-as-code. Each service's health check and replica count come from its own
     railway.*.toml. Set the path under Settings -> Config-as-code:
       seller -> railway.seller.toml   web -> railway.web.toml   verifier -> railway.verify.toml

  2. The seller's account needs testnet HBAR. Receipts cost a fraction of a cent
     each, but they are not free, and it will fail quietly when it runs dry.${c.off}
`);
