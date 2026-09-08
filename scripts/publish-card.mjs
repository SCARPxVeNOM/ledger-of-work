/**
 * Publish the seller's capability manifest to Hedera File Service.
 *
 * Run after the seller is up. Prints the file id; put it in .env as AGENT_CARD_FILE_ID
 * so the served manifest can point at its own on-chain copy.
 */
import "dotenv/config";
import { canonical } from "../packages/protocol/src/index.ts";
import { publishAgentCard, readAgentCard, updateAgentCard } from "../packages/receipts/src/index.ts";

const SELLER = process.env.SELLER_URL ?? "http://localhost:8402";
const options = {
  network: process.env.HEDERA_NETWORK ?? "testnet",
  accountId: process.env.SELLER_ACCOUNT_ID,
  privateKey: process.env.SELLER_PRIVATE_KEY,
};

const manifest = await fetch(`${SELLER}/`).then((r) => {
  if (!r.ok) throw new Error(`seller manifest unavailable (${r.status}) — is it running?`);
  return r.json();
});

// The card is the commitment, so strip anything that is merely this deployment's
// address. What a buyer needs to check a price is the catalogue and the price books.
const card = {
  name: manifest.name,
  description: manifest.description,
  x402Version: manifest.x402Version,
  payment: manifest.payment,
  receipts: manifest.receipts,
  capabilities: manifest.capabilities.map(({ quote: _quote, ...rest }) => rest),
  publishedAt: new Date().toISOString(),
};

const existing = process.env.AGENT_CARD_FILE_ID;
let fileId;

if (existing) {
  await updateAgentCard(existing, card, options);
  fileId = existing;
  console.log(`updated card   ${fileId}`);
} else {
  fileId = await publishAgentCard(card, options);
  console.log(`published card ${fileId}`);
  console.log(`\nadd to .env:\n  AGENT_CARD_FILE_ID=${fileId}`);
}

// Read it back the way a buyer would, so this script proves the round trip rather than
// assuming it.
const readBack = await readAgentCard(fileId, options);
// Compare canonically. The card is stored canonically (sorted keys), so a plain
// JSON.stringify comparison reports a mismatch purely from key order — which is exactly
// the failure mode canonical() exists to prevent, and it caught this script first.
const same = canonical(readBack) === canonical(card);
console.log(`\nread back      ${same ? "identical" : "MISMATCH"}`);
console.log(`capabilities   ${readBack.capabilities.map((c) => c.name).join(", ")}`);
console.log(`assets         ${readBack.payment.assets.map((a) => a.symbol).join(", ")}`);
console.log(`\nhashscan: https://hashscan.io/testnet/file/${fileId}`);
