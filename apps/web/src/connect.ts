import { LedgerId, Transaction } from "@hiero-ledger/sdk";
import { DAppConnector } from "@hashgraph/hedera-wallet-connect";

/**
 * Paying from the visitor's own wallet.
 *
 * The demo has always had two halves: a seller that charges for work, and a buyer that
 * signs for it. Hosting the second half is the problem — a key on a public server is a
 * key anyone can spend. This is the way out that does not involve holding one: the
 * visitor's wallet signs, on their phone, and this page never sees a private key at all.
 *
 * The x402 flow suits this better than it might look. The facilitator submits the
 * transaction, so the buyer only ever needs to *sign*, never to execute — which is
 * exactly what `hedera_signTransaction` does and is why it, rather than
 * `signAndExecuteTransaction`, is the method used here.
 *
 * ── The rule that makes this fiddly ─────────────────────────────────────────────
 * The Hedera `exact` scheme requires `transactionId.accountId` to be the *facilitator's*
 * fee payer, not the buyer. So the unsigned transaction cannot be built here from the
 * buyer's account alone — the server builds it from the 402 challenge (see
 * `buildUnsignedPayment`, which asserts that rule) and hands over bytes to sign. Get it
 * wrong and the facilitator returns `InvalidSignature` with no indication why.
 *
 * ── Status ──────────────────────────────────────────────────────────────────────
 * The seams either side of the wallet are tested; the round trip through a real wallet
 * is not, because exercising it needs a human with a phone. See docs/WALLETCONNECT.md.
 */

/** Publishable by design — WalletConnect project ids ship in client bundles. */
const PROJECT_ID = "a14234612450c639dd0adcbb729ddfd8";

const METADATA = {
  name: "Ledger of Work",
  description: "Proof of what a paid agent delivered, receipted on Hedera.",
  url: typeof location !== "undefined" ? location.origin : "https://localhost",
  icons: [],
};

export interface Connection {
  accountId: string;
  disconnect: () => Promise<void>;
}

let connector: DAppConnector | undefined;

/** Build the connector once. Calling `init` twice opens two sign clients. */
async function getConnector(): Promise<DAppConnector> {
  if (connector) return connector;
  const c = new DAppConnector(
    METADATA,
    LedgerId.TESTNET,
    PROJECT_ID,
    // Only the one method is requested. A wallet prompt that asks for the ability to
    // *execute* transactions when the dApp only ever needs a signature is asking for
    // more than it needs, and a careful user is right to refuse it.
    ["hedera_signTransaction"],
    ["chainChanged", "accountsChanged"],
    ["hedera:testnet"],
  );
  await c.init({ logger: "error" });
  connector = c;
  return c;
}

/** Open the wallet modal and return the account that connected. */
export async function connectWallet(): Promise<Connection> {
  const c = await getConnector();
  const session = await c.openModal();

  // HIP-30 form: `hedera:testnet:0.0.x`. The bare account id is what everything
  // downstream wants, so unwrap it here rather than in three places.
  const account = session.namespaces?.hedera?.accounts?.[0];
  const accountId = account?.split(":").pop();
  if (!accountId) throw new Error("the wallet connected but returned no account");

  return {
    accountId,
    disconnect: async () => {
      await c.disconnectAll().catch(() => {
        /* already gone; nothing to clean up */
      });
      connector = undefined;
    },
  };
}

/**
 * Have the connected wallet sign the server's unsigned payment.
 *
 * Takes and returns base64 because that is what survives a JSON round trip to the
 * server, and the server is where the x402 header is assembled — this function's only
 * job is the part that requires a key.
 */
export async function signPayment(accountId: string, unsignedBase64: string): Promise<string> {
  const c = await getConnector();
  const unsigned = Transaction.fromBytes(base64ToBytes(unsignedBase64));

  const result = await c.signTransaction({
    signerAccountId: `hedera:testnet:${accountId}`,
    transactionBody: unsigned,
  });

  // The method is documented as returning either a Transaction or a JSON-RPC result
  // wrapping signed bytes, depending on what the wallet sent back. Handle both rather
  // than assuming: the failure mode of guessing is a signature that silently never
  // reaches the facilitator.
  if (result instanceof Transaction) return bytesToBase64(result.toBytes());

  const signed = (result as { result?: { signedTransaction?: Uint8Array | string } }).result
    ?.signedTransaction;
  if (!signed) throw new Error("the wallet returned no signed transaction");
  return typeof signed === "string" ? signed : bytesToBase64(signed);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
