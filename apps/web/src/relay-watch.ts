/**
 * Notice when the WalletConnect relay refuses this origin.
 *
 * A WalletConnect project lists the origins allowed to use it. Serve the page from
 * anywhere else and the relay authenticates the JWT, opens the socket, and then closes it:
 *
 *   close code=3000  reason=Unauthorized: origin not allowed
 *
 * `@walletconnect/core` reads any close as a dropped connection and reconnects. That is
 * right for a flaky network and wrong here, because the answer cannot change: it asks
 * forever, `connect()` never settles, and the only outward sign is a button stuck on
 * "opening". Nothing is thrown and nothing is logged.
 *
 * ── Why this lives in the app bundle ────────────────────────────────────────────
 * The rejection is visible only on the socket, so catching it means wrapping
 * `WebSocket` — and the wrapper has to be in place *before* WalletConnect's transport
 * module evaluates, because it reads the global once at module scope and keeps that
 * reference. The connector is a dynamic import, so anything installed inside it is
 * already too late; it has to be installed here, by the bundle that runs first.
 */

/** Raised when the relay hangs up over the origin rather than the credentials. */
export class OriginNotAllowed extends Error {
  constructor(origin: string) {
    super(
      `WalletConnect is refusing connections from ${origin}. Add this origin to the ` +
        `project's allowed domains at dashboard.reown.com, then try again.`,
    );
    this.name = "OriginNotAllowed";
  }
}

const EVENT = "relay-origin-refused";

/**
 * Wrap `WebSocket` so a refused origin announces itself.
 *
 * Called once, at start-up, before the connector is imported. The wrapper stays for the
 * life of the page — it has to, since WalletConnect keeps its own reference — so it does
 * as little as possible: it looks at closes on relay sockets and forwards one event.
 */
export function installRelayWatch(): void {
  const Real = window.WebSocket;
  if ((Real as unknown as { __watched?: boolean }).__watched) return;

  const Patched = function (url: string | URL, protocols?: string | string[]) {
    const ws = new Real(url, protocols);
    if (String(url).includes("relay.walletconnect")) {
      ws.addEventListener("close", (e: CloseEvent) => {
        // 3000 is the relay's "I am refusing you", but it covers bad and expired tokens
        // as well as origins. Match the reason too — sending someone to edit their domain
        // allowlist over an expired JWT would cost them an afternoon.
        if (e.code === 3000 && /origin not allowed/i.test(e.reason)) {
          window.dispatchEvent(new CustomEvent(EVENT, { detail: location.origin }));
        }
      });
    }
    return ws;
  } as unknown as typeof WebSocket;

  Patched.prototype = Real.prototype;
  Object.assign(Patched, Real);
  (Patched as unknown as { __watched: boolean }).__watched = true;
  window.WebSocket = Patched;
}

/**
 * A promise that rejects if the relay refuses the origin during this attempt.
 *
 * Armed per attempt and disarmed by `stop`, so a refusal from one connection cannot
 * reject the next one. Raced against the connector rather than replacing it: every other
 * way of connecting still has to work normally.
 */
export function nextOriginRefusal(): { refused: Promise<never>; stop: () => void } {
  let onRefusal!: (e: Event) => void;
  const refused = new Promise<never>((_, reject) => {
    onRefusal = (e: Event) =>
      reject(new OriginNotAllowed((e as CustomEvent<string>).detail ?? location.origin));
    window.addEventListener(EVENT, onRefusal);
  });
  return { refused, stop: () => window.removeEventListener(EVENT, onRefusal) };
}
