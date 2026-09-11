import "dotenv/config";
import { startSeller } from "./server.js";

/**
 * Say something before anything can go wrong.
 *
 * A container that dies during startup often produces no logs at all — the process is
 * gone before the platform's collector attaches — and the deployment is reported as
 * "failed" with nothing to read. One line written immediately distinguishes "the process
 * never ran" from "the process ran and threw", which is the difference between
 * suspecting the image and suspecting the code.
 */
console.log(`seller starting — node ${process.version}, pid ${process.pid}`);

/**
 * Report a startup failure, then leave enough time for it to be read.
 *
 * `process.exit` discards anything still buffered on stdout. On a fast crash that
 * regularly means the error that explains everything is the one thing thrown away, so
 * the message goes out and the exit waits a moment behind it.
 */
async function fatal(where: string, err: unknown): Promise<never> {
  console.error(`
seller failed during ${where}:`);
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(1);
}

process.on("unhandledRejection", (err) => void fatal("an unawaited promise", err));
process.on("uncaughtException", (err) => void fatal("an uncaught exception", err));

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env — see .env.example`);
  return v;
}

/**
 * The published conversion rate. Fixed and declared rather than fetched: a buyer must be
 * able to reproduce the price from the manifest alone, and an oracle-derived rate would
 * make yesterday's receipt unverifiable today.
 */
const paymentToken = process.env.PAYMENT_TOKEN_ID
  ? {
      id: process.env.PAYMENT_TOKEN_ID,
      symbol: process.env.PAYMENT_TOKEN_SYMBOL ?? "WORK",
      decimals: Number(process.env.PAYMENT_TOKEN_DECIMALS ?? 2),
      unitsPerTinybar: process.env.PAYMENT_TOKEN_RATE ?? "0.001",
    }
  : undefined;

/**
 * The address this seller tells buyers to come back to.
 *
 * The manifest and every 402 challenge carry absolute URLs, so a hosted seller that does
 * not know its own public address hands out `http://localhost:8402` and every buyer that
 * is not on the same machine fails on the *second* request — after a successful quote,
 * which makes it look like the payment broke rather than the address.
 *
 * `RAILWAY_PUBLIC_DOMAIN` is read directly so that deploying there needs no extra
 * configuration; PUBLIC_URL overrides it for anywhere else.
 */
const publicUrl =
  process.env.PUBLIC_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);

const seller = await startSeller({
  port: Number(process.env.PORT ?? 8402),
  network: process.env.X402_NETWORK ?? "hedera:testnet",
  facilitatorUrl: process.env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com",
  facilitatorApiKey: process.env.FACILITATOR_API_KEY,
  sellerAccountId: required("SELLER_ACCOUNT_ID"),
  sellerPrivateKey: required("SELLER_PRIVATE_KEY"),
  topicId: required("SELLER_TOPIC_ID"),
  paymentToken,
  agentCardFileId: process.env.AGENT_CARD_FILE_ID,
  ...(publicUrl ? { publicUrl } : {}),
  quoteStorePath: process.env.QUOTE_STORE_PATH ?? ".data/quotes.json",
  zkOwnerKey: process.env.ZKTLS_OWNER_KEY,
}).catch((err) => fatal("startup", err));

console.log(`seller listening on ${publicUrl ?? `http://localhost:${seller.port}`}`);
console.log(`  manifest   http://localhost:${seller.port}/`);
console.log(`  fee payer  ${seller.feePayer}`);
console.log(`  receipts   https://hashscan.io/testnet/topic/${process.env.SELLER_TOPIC_ID}`);
if (process.env.AGENT_CARD_FILE_ID) {
  console.log(`  card       https://hashscan.io/testnet/file/${process.env.AGENT_CARD_FILE_ID}`);
}
console.log(
  `  assets     HBAR${paymentToken ? ` + ${paymentToken.symbol} (${paymentToken.id}) at ${paymentToken.unitsPerTinybar} units/tinybar` : ""}`,
);
console.log(
  `  proofs     ${process.env.ZKTLS_OWNER_KEY ? "on — capable jobs get an attestor's signature" : "off — set ZKTLS_OWNER_KEY to witness retrievals"}`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    seller.close().then(() => process.exit(0));
  });
}
