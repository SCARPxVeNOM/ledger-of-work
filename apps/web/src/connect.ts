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

/**
 * Say where we got to, with a timestamp.
 *
 * Connecting a wallet is four steps across two libraries and a relay, and when it stalls
 * the page can only say "connecting". Every step is announced here so a stall names the
 * step it stalled on instead of having to be guessed at from the outside.
 */
const t0 = Date.now();
function trace(stage: string, detail?: unknown): void {
  console.info(`[wallet] ${String(Date.now() - t0).padStart(5)}ms  ${stage}`, detail ?? "");
}

/**
 * Drop pairings that outlived the tab which made them.
 *
 * Pairings are kept in localStorage, so a visitor who closes the tab without disconnecting
 * leaves them behind. The next load restores them and subscribes to their topics, and the
 * relay then delivers traffic for a peer that is long gone — which is how a page that has
 * done nothing yet still reports `Pending session not found for topic` and
 * `No matching key. proposal:` before anyone has touched the button.
 *
 * Only the dead ones. An active pairing that has not expired is a wallet the visitor may
 * still be paired with, and dropping it would demand a fresh QR scan for no reason.
 *
 * Expiries are unix **seconds** here, not milliseconds.
 */
async function pruneStalePairings(c: DAppConnector): Promise<void> {
  const pairing = c.walletConnectClient?.core?.pairing;
  if (!pairing) return;

  const now = Math.floor(Date.now() / 1000);
  const stale = pairing.getPairings().filter((p) => !p.active || p.expiry <= now);
  if (!stale.length) return;

  trace(`pruning ${stale.length} stale pairing(s)`);
  await Promise.all(
    stale.map((p) =>
      pairing.disconnect({ topic: p.topic }).catch(() => {
        /* already gone — the point was that it should not be here */
      }),
    ),
  );
}

/**
 * The build in progress, if there is one.
 *
 * Two clicks land before the first `init` resolves and both see an empty `connector`, so
 * both construct one — and the loser's is never referenced again but goes on running.
 * Sharing the promise makes concurrent callers wait for the same connector instead.
 */
let building: Promise<DAppConnector> | undefined;

/** Build the connector once. Calling `init` twice opens two sign clients. */
async function getConnector(): Promise<DAppConnector> {
  if (connector) return connector;
  if (building) return building;

  building = (async () => {
    trace("constructing connector");
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
    // `init` opens the sign client and its relay socket. If the project id is rejected,
    // this is where it surfaces.
    trace("init: opening sign client");
    try {
      await c.init({ logger: "error" });
    } catch (err) {
      trace("init: FAILED", (err as Error).message);
      throw err;
    }
    trace("init: ok");
    await pruneStalePairings(c);
    connector = c;
    return c;
  })();

  try {
    return await building;
  } finally {
    // Cleared either way. A failed init must not be cached as the answer forever.
    building = undefined;
  }
}

/**
 * Close the relay socket and forget the connector.
 *
 * Dropping the reference alone was the bug behind every wallet error in the console.
 * `disconnectAll` ends the *sessions*; it does not close the sign client's socket or
 * unsubscribe it, so an abandoned connector keeps listening on topics whose state went
 * with it. The relay then delivers messages it can no longer place — `Pending session not
 * found for topic`, `No matching key. proposal:`, `failed to process an inbound msg` —
 * and because the old Core is still registered, building the replacement announces
 * `Init() was called 2 times`.
 *
 * So the socket is closed before the reference goes. Kept synchronous for its callers:
 * they are handling an error and have nothing to do with the outcome, and a teardown that
 * fails must not become a second error on top of the first.
 */
export function resetConnector(): void {
  const old = connector;
  connector = undefined;
  building = undefined;
  if (!old) return;

  trace("resetConnector: closing relay transport");
  void Promise.resolve()
    .then(() => old.walletConnectClient?.core?.relayer?.transportClose())
    .catch(() => {
      /* already down, or never opened; either way there is nothing left to close */
    });
}

/** Raised when the visitor dismisses the wallet modal. Not a fault; the caller says so. */
export class WalletCancelled extends Error {
  constructor() {
    super("wallet connection cancelled");
    this.name = "WalletCancelled";
  }
}

/**
 * Open the wallet modal and return the account that connected.
 *
 * ── The second argument is the whole point ──────────────────────────────────────
 * `openModal(pairingTopic, throwErrorOnReject)` defaults `throwErrorOnReject` to **false**,
 * and with it false the connector subscribes to nothing: closing the modal does not
 * reject, `approval()` never resolves, and the promise stays pending for the life of the
 * page. Every caller then sits on whatever "connecting…" state it set, forever, with no
 * error to report and nothing in the console — which is precisely what it looked like.
 *
 * Passing `true` makes dismissal reject, so a cancelled connection is an outcome rather
 * than a hang.
 *
 * The timeout is the second half of the same problem. Rejection covers the visitor
 * closing the modal; it does not cover a relay that accepts the pairing and never
 * delivers an approval, which leaves the same pending promise by a different route. A
 * connection nobody is going to complete should end by itself.
 */
export async function connectWallet(timeoutMs = 60_000): Promise<Connection> {
  const c = await getConnector();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("the wallet did not respond — close the modal and try again")),
      timeoutMs,
    );
  });

  let session: Awaited<ReturnType<typeof c.openModal>>;
  try {
    trace("openModal: requesting pairing uri");
    session = await Promise.race([c.openModal(undefined, true), expiry]);
    trace("openModal: approved", session.namespaces?.hedera?.accounts);
  } catch (err) {
    trace("openModal: FAILED", (err as Error).message);
    // The connector words dismissal as a rejected pairing. Rename it, so the caller can
    // tell "they changed their mind" from "something broke".
    if (/rejected pairing/i.test((err as Error).message)) throw new WalletCancelled();
    throw err;
  } finally {
    clearTimeout(timer);
    // On the timeout and relay paths the connector's own `finally` has not run, so the
    // modal would otherwise be left open over a page that has given up waiting for it.
    c.walletConnectModal.closeModal();
  }

  // HIP-30 form: `hedera:testnet:0.0.x`. The bare account id is what everything
  // downstream wants, so unwrap it here rather than in three places.
  const account = session.namespaces?.hedera?.accounts?.[0];
  const accountId = account?.split(":").pop();
  if (!accountId) throw new Error("the wallet connected but returned no account");

  return {
    accountId,
    /**
     * End the session, and keep the connector.
     *
     * It used to drop the connector too, which is what made reconnecting noisy: the next
     * click built a second one, the first was never torn down, and the two Cores produced
     * `Init() was called 2 times` followed by relay traffic the survivor could not place.
     *
     * Nothing about the connector is session-specific — it is a client and a socket, and
     * reusing it is what the library expects. The session is the thing being ended, and
     * `disconnectAll` ends it and its pairings, which is the whole of what disconnect means
     * here. A page that connects, disconnects and connects again now opens exactly one.
     */
    disconnect: async () => {
      await c.disconnectAll().catch(() => {
        /* already gone; nothing to clean up */
      });
      trace("disconnected; connector kept for the next connect");
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
