/**
 * A service that is not this one, selling something that is not web work.
 *
 * The whole settlement-rail design rests on a claim: the receipt machinery is not about
 * browsers. It is about paying software for work, and the web jobs in this repository are
 * one instance rather than the point.
 *
 * This is the smallest thing that tests that claim honestly. A word-count endpoint,
 * metered per token, with no Playwright, no adapter, no capability in our catalogue, and
 * no relationship to the rest of the repo beyond importing `@low/gate`. It emits a v4
 * receipt whose signature anyone can check against a key it publishes.
 *
 *   node scripts/toy-adopter.mjs
 *   curl -s -X POST localhost:8410 -H 'content-type: application/json' \
 *        -d '{"text":"one two three four five"}'
 *
 * Not a product and not deployed. It exists so the claim can be falsified.
 */
import { createServer } from "node:http";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { hashCanonical } from "../packages/protocol/src/index.ts";
import { buildReceipt, decideSettlement, quoteFor } from "../packages/gate/src/index.ts";

/**
 * A throwaway key, generated per run.
 *
 * A real adopter holds a durable one and lists its public half in the directory. Making
 * one up here keeps a private key out of the repository, and costs only that receipts
 * from two different runs verify against different keys — which is correct, since they
 * were signed by different identities.
 */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const config = {
  capability: "text.wordcount",
  // Published before any request arrives, which is what makes a quote checkable.
  book: {
    base: "1000",
    perStep: "0",
    perPage: "0",
    perSecond: "0",
    ceiling: "1000000",
    per: { tokens: "5" },
  },
  price: (req) => ({ tokens: words(req.body?.text).length }),
  evidence: (out) => ({ output: hashCanonical(out) }),
  // A count of nothing is not a count. Charging for it is the failure this project
  // already shipped once, against a page that turned out to be a bot challenge.
  delivered: (out) =>
    out.words > 0 ? { ok: true } : { ok: false, why: "no words to count. Nothing was charged." },
};

const identity = {
  alg: "ed25519",
  by: "uaid:aid:toyadopter",
  sign: (bytes) => nodeSign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64url"),
};

const words = (text) => String(text ?? "").split(/\s+/).filter(Boolean);

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);

  let body;
  try {
    body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "body must be JSON" }));
    return;
  }

  // Price first, from the published book, before any work happens.
  const quote = quoteFor(config, { body });

  // The work. A real adopter would call a model here; the shape is the same either way.
  const out = { words: quote.units.tokens };

  const decision = decideSettlement(config, out);
  const now = new Date().toISOString();

  const receipt = buildReceipt(config, {
    jobId: `toy-${Date.now()}`,
    units: quote.units,
    out,
    amount: quote.amount,
    // `exact` admits no partial settlement, so the options are the quoted number or zero.
    charged: decision.settle ? quote.amount : "0",
    payer: "0.0.10513903",
    payTo: "0.0.999",
    network: "hedera:testnet",
    asset: "0.0.0",
    startedAt: now,
    finishedAt: new Date().toISOString(),
    status: decision.settle ? "ok" : "failed",
    identity,
  });

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      {
        result: out,
        quote,
        ...(decision.settle ? {} : { refused: decision.why }),
        // The buyer holds the signed receipt now, before anything reaches HCS. A relay
        // outage would delay permanence; it could not destroy this.
        receipt,
        publicKey: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
      },
      null,
      2,
    ),
  );
}).listen(8410, () => {
  console.log('toy adopter on :8410 — POST {"text":"..."}');
});
