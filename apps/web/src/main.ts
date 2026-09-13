import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  buildUnsignedPayment,
  payloadFromSignedBytes,
  type PaymentRequirements,
} from "@low/buyer-cli";
import { serveAsset } from "./assets.js";
import { readUsage, verifyFromMirror, type VerifyRequest } from "@low/receipts";
import { CATALOGUE } from "@low/worker";

/**
 * Demo server for the browser UI.
 *
 * It holds no keys. Signing happens in the buyer's own wallet process (`pnpm wallet`),
 * which this calls over loopback with a shared secret — so the thing rendering the
 * seller's UI is not also the custodian of the buyer's funds, and a compromise of this
 * frontend cannot spend anything. The wallet enforces its own spend policy that this
 * process cannot raise.
 *
 * Everything else the page needs — the live meter and the verification — it reads
 * directly. The meter comes from the seller's SSE stream, and the verifier runs against
 * the public mirror node here, using exactly the same code path as the CLI.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SELLER = process.env.SELLER_URL ?? "http://localhost:8402";
const PORT = Number(process.env.PORT ?? process.env.WEB_PORT ?? 8403);
/** See the verifier's server: Node's default bind is not reachable behind a proxy. */
const HOST = process.env.HOST ?? "0.0.0.0";
const WALLET = process.env.WALLET_URL ?? "http://127.0.0.1:8404";
const WALLET_TOKEN = process.env.WALLET_TOKEN;

/**
 * Payments waiting for a wallet signature.
 *
 * The 402 challenge is fetched here and kept here. The browser gets an opaque id and the
 * bytes to sign, never the requirements themselves — otherwise `complete` would have to
 * trust a client-supplied description of what is being paid, which turns this server into
 * a relay that will wrap whatever it is handed.
 *
 * In memory and short-lived on purpose: a pending signature is worth nothing once the
 * quote behind it has expired, and surviving a restart is not a property worth having
 * for something the user is actively looking at.
 */
interface Pending {
  runUrl: string;
  requirements: PaymentRequirements;
  expiresAt: number;
}
const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 5 * 60_000;

function reapPending(): void {
  const now = Date.now();
  for (const [id, p] of pending) if (p.expiresAt < now) pending.delete(id);
}

/** Ask the buyer's wallet to sign. The key never enters this process. */
async function signWithWallet(requirements: PaymentRequirements): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${WALLET}/sign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(WALLET_TOKEN ? { authorization: `Bearer ${WALLET_TOKEN}` } : {}),
      },
      body: JSON.stringify({ requirements }),
    });
  } catch {
    throw new Error(`no wallet at ${WALLET} — start it with \`pnpm wallet\``);
  }
  const body = (await res.json()) as { header?: string; message?: string; error?: string };
  if (!res.ok || !body.header) {
    // A refusal is the wallet doing its job, so surface its reason rather than a generic
    // failure — "over the per-payment limit" is actionable, "payment failed" is not.
    throw new Error(body.message ?? body.error ?? `wallet returned ${res.status}`);
  }
  return body.header;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
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

/**
 * Fetch the 402 and return what it asks for.
 *
 * A response that is not a 402 is a bug worth surfacing rather than retrying: it means
 * the seller let the job through unpaid, or refused it for a reason the buyer should see.
 */
async function challenge(
  runUrl: string,
): Promise<{ accepts: PaymentRequirements } | { error: string; status: number }> {
  if (!runUrl?.startsWith(SELLER)) {
    return { error: "run url must belong to the configured seller", status: 400 };
  }
  const res = await fetch(runUrl, { method: "POST" });
  if (res.status !== 402) return { error: `expected 402, got ${res.status}`, status: 502 };
  const { accepts } = (await res.json()) as { accepts: PaymentRequirements[] };
  const first = accepts?.[0];
  if (!first) return { error: "the 402 named no acceptable payment", status: 502 };
  return { accepts: first };
}

/** Re-run the job with the signed payment attached. */
async function settle(res: ServerResponse, runUrl: string, header: string): Promise<void> {
  const paid = await fetch(runUrl, { method: "POST", headers: { "payment-signature": header } });
  return send(res, paid.status, await paid.json());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === "/" || path === "/index.html") {
      const html = readFileSync(join(HERE, "..", "public", "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // The app bundle, its stylesheet, and the self-hosted fonts. The
    // allowlist is a literal set rather than a path join: this server sits in front of a
    // repo checkout, and "serve whatever is under public/" is one `..` away from serving
    // the seller's environment.
    if (
      path === "/fonts.css" ||
      path === "/app.css" ||
      path === "/app.js" ||
      /^\/fonts\/[\w.-]+\.(woff2|txt)$/.test(path) ||
      /^\/art\/[\w.-]+\.webp$/.test(path) ||
      /^\/marks\/[\w.-]+\.svg$/.test(path)
    ) {
      try {
        const file = readFileSync(join(HERE, "..", "public", path.replace(/^\//, "")));
        const type = path.endsWith(".css")
          ? "text/css; charset=utf-8"
          : path.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : path.endsWith(".woff2")
              ? "font/woff2"
              : path.endsWith(".webp")
                ? "image/webp"
                : path.endsWith(".svg")
                  ? "image/svg+xml"
                : "text/plain; charset=utf-8";
        // Fonts and artwork carry their size in the filename, so a changed file is a
        // changed URL and a year is safe. The bundles keep one name across every deploy,
        // so they get revalidated instead — see `serveAsset`.
        const immutable = path.startsWith("/fonts") || path.startsWith("/art");
        serveAsset(req, res, file, type, immutable);
      } catch {
        res.writeHead(404).end("not found");
      }
      return;
    }

    // The wallet connector bundle. Requested only when someone clicks connect, so a
    // missing build degrades that one button rather than blanking the page — worth
    // saying out loud in the response instead of returning a bare 404 that surfaces as
    // an unexplained import failure in the console.
    if (path === "/connect.js") {
      try {
        const js = readFileSync(join(HERE, "..", "public", "connect.js"));
        serveAsset(req, res, js, "text/javascript; charset=utf-8", false);
      } catch {
        res.writeHead(503, { "content-type": "text/javascript; charset=utf-8" });
        res.end(`throw new Error("connect.js was not built — run \`pnpm --filter @low/web build\`");`);
      }
      return;
    }

    // Capability catalogue, so the form is built from the real specs.
    // Lets the page tell the operator the wallet is missing before they try to pay.
    if (path === "/api/wallet") {
      try {
        const w = await fetch(`${WALLET}/health`).then((r) => r.json());
        return send(res, 200, { connected: true, ...(w as object) });
      } catch {
        return send(res, 200, { connected: false, url: WALLET });
      }
    }

    // Usage read from the public topic, so the page shows the same numbers a sceptic
    // would compute themselves rather than anything this server asserts.
    if (path === "/api/usage") {
      const topicId = process.env.SELLER_TOPIC_ID;
      if (!topicId) return send(res, 200, { available: false });
      try {
        const report = await readUsage(topicId, {
          ...(process.env.MIRROR_NODE_URL ? { baseUrl: process.env.MIRROR_NODE_URL } : {}),
          limit: 100,
        });
        return send(res, 200, { available: true, ...report });
      } catch (err) {
        return send(res, 200, { available: false, error: (err as Error).message });
      }
    }

    if (path === "/api/capabilities") {
      const manifest = await fetch(`${SELLER}/`).then((r) => r.json());
      return send(res, 200, manifest);
    }

    // Step 1: price the job. Free, and nothing is signed yet.
    if (path === "/api/quote" && req.method === "POST") {
      const body = await readJson(req);
      const quoted = await fetch(`${SELLER}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return send(res, quoted.status, await quoted.json());
    }

    // Step 2: pay the 402 and run. Blocks until the job finishes; the page watches the
    // seller's SSE stream in parallel for the live meter.
    if (path === "/api/run" && req.method === "POST") {
      const { runUrl } = (await readJson(req)) as { runUrl: string };
      const requirements = await challenge(runUrl);
      if ("error" in requirements) return send(res, requirements.status, { error: requirements.error });

      const header = await signWithWallet(requirements.accepts);
      return settle(res, runUrl, header);
    }

    // ── Paying from the visitor's own wallet ──────────────────────────────────
    //
    // Split in two because a wallet signature happens on someone's phone, which is a
    // human-scale pause in the middle of an HTTP request. `prepare` gets the challenge
    // and the bytes; `complete` takes the signature back.
    //
    // The buyer's account id comes from the connected wallet, and it has to: the payment
    // transfers from *that* account, so building the transaction against any other would
    // produce a signature the facilitator rejects.
    if (path === "/api/pay/prepare" && req.method === "POST") {
      const { runUrl, buyerAccountId } = (await readJson(req)) as {
        runUrl: string;
        buyerAccountId: string;
      };
      if (!/^\d+\.\d+\.\d+$/.test(buyerAccountId ?? "")) {
        return send(res, 400, { error: "buyerAccountId must be a Hedera account id" });
      }

      const got = await challenge(runUrl);
      if ("error" in got) return send(res, got.status, { error: got.error });

      const unsigned = buildUnsignedPayment(got.accepts, buyerAccountId);

      reapPending();
      const payId = randomUUID();
      pending.set(payId, {
        runUrl,
        requirements: got.accepts,
        expiresAt: Date.now() + PENDING_TTL_MS,
      });

      return send(res, 200, {
        payId,
        unsigned: Buffer.from(unsigned.bytes).toString("base64"),
        transactionId: unsigned.transactionId,
        amount: got.accepts.amount,
        payTo: got.accepts.payTo,
        asset: got.accepts.asset,
      });
    }

    if (path === "/api/pay/complete" && req.method === "POST") {
      const { payId, signed } = (await readJson(req)) as { payId: string; signed: string };
      reapPending();
      const p = pending.get(payId);
      if (!p) {
        return send(res, 410, {
          error: "that payment is no longer pending — it expired or was already used",
        });
      }
      // One signature per prepare. A replayed id cannot be used to submit twice.
      pending.delete(payId);

      const header = payloadFromSignedBytes(p.requirements, Buffer.from(signed, "base64"));
      return settle(res, p.runUrl, header);
    }

    // Step 3: verify. Same code the CLI runs, against the same public mirror node.
    if (path === "/api/verify" && req.method === "POST") {
      const body = (await readJson(req)) as {
        topicId: string;
        sequenceNumber: number;
        result: unknown;
        capability?: string;
        // The artifacts the buyer was handed when the job ran. Passing them back is what
        // lets the evidence and retrieval checks actually run: without them the verifier
        // reports "not checked" — correctly, but the page then stamps VOID on a receipt
        // that is perfectly good, which is a worse lie than the one it is guarding against.
        pageHtml?: string;
        screenshotBase64?: string;
        retrievalProof?: unknown;
      };
      const priceBook = body.capability ? CATALOGUE[body.capability]?.spec.priceBook : undefined;
      const out = await verifyFromMirror(
        {
          topicId: body.topicId,
          sequenceNumber: Number(body.sequenceNumber),
          result: body.result,
          expectedSubmitter: env("SELLER_ACCOUNT_ID"),
          ...(priceBook ? { priceBook } : {}),
          ...(typeof body.pageHtml === "string" ? { pageHtml: body.pageHtml } : {}),
          ...(typeof body.screenshotBase64 === "string"
            ? { screenshot: Buffer.from(body.screenshotBase64, "base64") }
            : {}),
          ...(body.retrievalProof
            ? { retrievalProof: body.retrievalProof as NonNullable<VerifyRequest["retrievalProof"]> }
            : {}),
        },
        process.env.MIRROR_NODE_URL ? { baseUrl: process.env.MIRROR_NODE_URL } : {},
      );
      return send(res, 200, { ok: out.ok, checks: out.checks, evidence: out.evidence });
    }

    send(res, 404, { error: "not_found" });
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`demo UI   http://${HOST}:${PORT}`);
  console.log(`seller    ${SELLER}`);
});
