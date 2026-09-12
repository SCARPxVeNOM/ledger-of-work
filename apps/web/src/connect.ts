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

/** Build the connector once. Calling `init` twice opens two sign clients. */
async function getConnector(): Promise<DAppConnector> {
  if (connector) return connector;
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
  connector = c;
  return c;
}

/**
 * Raised when the relay hangs up because this origin is not on the project's allowlist.
 *
 * A WalletConnect project names the origins allowed to use it. If the page is served from
 * anywhere else the relay accepts the JWT, opens the socket, and then closes it with
 * `3000 Unauthorized: origin not allowed` — so the credentials are right and the
 * deployment is wrong, which is a distinction worth putting in front of whoever deployed it.
 */
export class OriginNotAllowed extends Error {
  constructor(origin: string) {
    super(
      `WalletConnect is refusing connections from ${origin}. Add this origin to the ` +
        `project's allowed domains at dashboard.reown.com and try again.`,
    );
    this.name = "OriginNotAllowed";
  }
}

/**
 * Watch the relay socket for the one failure the SDK will not report.
 *
 * `@walletconnect/core` treats a closed socket as a transient network problem and
 * reconnects, which is right for a dropped connection and wrong for a rejected origin:
 * the answer will be identical every time, so it retries until the page is closed while
 * `connect()` stays pending. Nothing reaches the caller, nothing reaches the console, and
 * the only outward sign is a button that never stops saying "opening".
 *
 * The rejection is only visible on the socket itself, so this wraps `WebSocket` for the
 * duration of the attempt and puts it back afterwards. Scoped deliberately: a permanent
 * patch on a global would outlive the thing it exists to diagnose.
 */
function watchRelay(): { failed: Promise<never>; stop: () => void } {
  const Real = window.WebSocket;
  let reject!: (e: Error) => void;
  const failed = new Promise<never>((_, r) => (reject = r));

  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const ws = new Real(url, protocols);
    if (String(url).includes("relay.walletconnect")) {
      ws.addEventListener("close", (e: CloseEvent) => {
        // 3000 is the relay's application-level "I am refusing you". The reason string is
        // matched too, because 3000 also covers an expired or malformed JWT, and telling
        // someone to edit their allowlist over a bad token would send them the wrong way.
        if (e.code === 3000 && /origin not allowed/i.test(e.reason)) {
          reject(new OriginNotAllowed(location.origin));
        }
      });
    }
    return ws;
  } as unknown as typeof WebSocket;
  Patched.prototype = Real.prototype;
  Object.assign(Patched, Real);

  window.WebSocket = Patched;
  return { failed, stop: () => void (window.WebSocket = Real) };
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
  // Installed before the connector: `init` opens the relay socket, so a rejected origin
  // is already being retried by the time `openModal` is called.
  const relay = watchRelay();
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
    session = await Promise.race([c.openModal(undefined, true), relay.failed, expiry]);
    trace("openModal: approved", session.namespaces?.hedera?.accounts);
  } catch (err) {
    trace("openModal: FAILED", (err as Error).message);
    // A refused origin leaves the cached connector holding a relayer that will go on
    // retrying a socket it can never keep. Drop it, so that fixing the allowlist and
    // pressing the button again builds a fresh one rather than rejoining the old loop.
    if (err instanceof OriginNotAllowed) connector = undefined;
    // The connector words dismissal as a rejected pairing. Rename it, so the caller can
    // tell "they changed their mind" from "something broke".
    if (/rejected pairing/i.test((err as Error).message)) throw new WalletCancelled();
    throw err;
  } finally {
    clearTimeout(timer);
    relay.stop();
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
