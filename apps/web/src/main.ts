import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPayment, type PaymentRequirements } from "@low/buyer-cli";
import { verifyFromMirror } from "@low/receipts";
import { CATALOGUE } from "@low/worker";

/**
 * Demo server for the browser UI.
 *
 * The buyer's key lives here rather than in the page: a demo that put a private key in
 * client-side JavaScript would be teaching the wrong lesson, however convenient. The
 * page drives the flow; this process signs.
 *
 * Everything else the page needs — the live meter and the verification — it reads
 * directly. The meter comes from the seller's SSE stream, and the verifier runs against
 * the public mirror node here, using exactly the same code path as the CLI.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SELLER = process.env.SELLER_URL ?? "http://localhost:8402";
const PORT = Number(process.env.WEB_PORT ?? 8403);

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

    // Capability catalogue, so the form is built from the real specs.
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
      if (!runUrl?.startsWith(SELLER)) {
        return send(res, 400, { error: "run url must belong to the configured seller" });
      }

      const challenge = await fetch(runUrl, { method: "POST" });
      if (challenge.status !== 402) {
        return send(res, 502, { error: `expected 402, got ${challenge.status}` });
      }
      const { accepts } = (await challenge.json()) as { accepts: PaymentRequirements[] };

      const header = await buildPayment(accepts[0] as PaymentRequirements, {
        accountId: env("BUYER_ACCOUNT_ID"),
        privateKey: env("BUYER_PRIVATE_KEY"),
        network: process.env.HEDERA_NETWORK ?? "testnet",
      });

      const paid = await fetch(runUrl, { method: "POST", headers: { "payment-signature": header } });
      return send(res, paid.status, await paid.json());
    }

    // Step 3: verify. Same code the CLI runs, against the same public mirror node.
    if (path === "/api/verify" && req.method === "POST") {
      const body = (await readJson(req)) as {
        topicId: string;
        sequenceNumber: number;
        result: unknown;
        capability?: string;
      };
      const priceBook = body.capability ? CATALOGUE[body.capability]?.spec.priceBook : undefined;
      const out = await verifyFromMirror(
        {
          topicId: body.topicId,
          sequenceNumber: Number(body.sequenceNumber),
          result: body.result,
          expectedSubmitter: env("SELLER_ACCOUNT_ID"),
          ...(priceBook ? { priceBook } : {}),
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

server.listen(PORT, () => {
  console.log(`demo UI   http://localhost:${PORT}`);
  console.log(`seller    ${SELLER}`);
});
