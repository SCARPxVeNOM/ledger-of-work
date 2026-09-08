import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildPayment, type PaymentRequirements } from "@low/buyer-cli";
import { DEFAULT_POLICY, SpendLedger, checkPolicy, type SpendPolicy } from "./policy.js";

/**
 * The buyer's wallet, as its own process.
 *
 * The point is what this removes: the demo web server used to hold the buyer's private
 * key, which made the thing showing you the seller's UI also the custodian of your
 * funds. Now the key lives here, the web app calls out to sign, and a compromise of the
 * frontend cannot spend anything.
 *
 * This is also the realistic shape for the actual user of this product. A buying agent
 * has its own wallet; it does not hand its key to every service it shops at. For a human
 * buyer the same interface is served by WalletConnect and a phone — see README for where
 * that plugs in.
 *
 * Two things make this a wallet rather than a signing oracle:
 *   - it requires a shared secret, so anything else on localhost cannot spend your money
 *   - it enforces its own spend policy, which the caller cannot raise
 */

const PORT = Number(process.env.WALLET_PORT ?? 8404);
const TOKEN = process.env.WALLET_TOKEN;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

const accountId = required("BUYER_ACCOUNT_ID");
const privateKey = required("BUYER_PRIVATE_KEY");
const network = process.env.HEDERA_NETWORK ?? "testnet";

const policy: SpendPolicy = {
  maxPerPayment: process.env.WALLET_MAX_PER_PAYMENT ?? DEFAULT_POLICY.maxPerPayment,
  maxTotal: process.env.WALLET_MAX_TOTAL ?? DEFAULT_POLICY.maxTotal,
  allowedAssets: (process.env.WALLET_ALLOWED_ASSETS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  allowedRecipients: (process.env.WALLET_ALLOWED_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};

const ledger = new SpendLedger();

/** Constant-time compare, so the token cannot be discovered a character at a time. */
function tokenOk(header: string | undefined): boolean {
  if (!TOKEN) return true; // no token configured: local dev only, warned about at boot
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${TOKEN}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 32 * 1024) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", `http://localhost:${PORT}`).pathname;

  try {
    if (path === "/health") {
      // Deliberately does not reveal the policy or spend to an unauthenticated caller.
      return send(res, 200, { ok: true, accountId, network });
    }

    if (!tokenOk(req.headers.authorization)) {
      return send(res, 401, { error: "unauthorized", message: "missing or bad WALLET_TOKEN" });
    }

    if (path === "/status") {
      return send(res, 200, { accountId, network, policy, spent: ledger.summary() });
    }

    if (path === "/sign" && req.method === "POST") {
      const body = await readJson(req);
      const requirements = body.requirements as PaymentRequirements | undefined;
      if (!requirements?.amount || !requirements.payTo || !requirements.extra?.feePayer) {
        return send(res, 400, { error: "bad_request", message: "requirements incomplete" });
      }

      // Policy first. Nothing is signed until the wallet has agreed to the payment.
      const verdict = checkPolicy(
        { amount: requirements.amount, asset: requirements.asset, payTo: requirements.payTo },
        policy,
        ledger.spent(requirements.asset),
      );
      if (!verdict.allowed) {
        return send(res, 403, { error: "policy_refused", message: verdict.reason });
      }

      const header = await buildPayment(requirements, { accountId, privateKey, network });
      ledger.record(requirements.asset, requirements.amount);

      return send(res, 200, { header, payer: accountId });
    }

    send(res, 404, { error: "not_found" });
  } catch (err) {
    send(res, 500, { error: "internal", message: (err as Error).message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`wallet    http://127.0.0.1:${PORT}  (loopback only)`);
  console.log(`  account ${accountId} on ${network}`);
  console.log(`  policy  max ${policy.maxPerPayment}/payment, ${policy.maxTotal} total`);
  if (policy.allowedAssets.length) console.log(`          assets ${policy.allowedAssets.join(", ")}`);
  if (policy.allowedRecipients.length) console.log(`          payees ${policy.allowedRecipients.join(", ")}`);
  if (!TOKEN) {
    console.log(
      "  WARNING no WALLET_TOKEN set — any process on this machine can ask this wallet to pay.",
    );
  }
});
