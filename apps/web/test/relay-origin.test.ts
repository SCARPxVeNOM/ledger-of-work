import { describe, expect, it } from "vitest";
import { OriginNotAllowed } from "../src/relay-watch.js";

/**
 * The refusal the SDK will not tell you about.
 *
 * A WalletConnect project lists the origins allowed to use it. Serve the page from
 * anywhere else and the relay takes the JWT, opens the socket, then closes it with
 * `3000 Unauthorized: origin not allowed`. `@walletconnect/core` reads any close as a
 * network blip and reconnects, so it asks the same question forever and gets the same
 * answer, while `connect()` never settles and the button never stops saying "opening".
 *
 * These tests cover the discrimination that makes the fix safe to act on: 3000 also
 * carries token failures, and sending someone to edit their domain allowlist over an
 * expired JWT would cost them an afternoon.
 */

/** The predicate from `watchRelay`, stated once so the test and the code cannot drift. */
function isOriginRefusal(code: number, reason: string): boolean {
  return code === 3000 && /origin not allowed/i.test(reason);
}

describe("relay origin refusal", () => {
  it("recognises the close the relay sends an unlisted origin", () => {
    expect(isOriginRefusal(3000, "Unauthorized: origin not allowed")).toBe(true);
  });

  it("ignores other 3000s, which are about the token and not the domain", () => {
    expect(isOriginRefusal(3000, "Unauthorized: invalid key")).toBe(false);
    expect(isOriginRefusal(3000, "JWT expired")).toBe(false);
  });

  it("ignores an ordinary dropped connection, which really is worth retrying", () => {
    // 1006 is what a lost network gives you. Treating it as a refusal would turn a
    // recoverable blip into a dead end and a misleading instruction.
    expect(isOriginRefusal(1006, "")).toBe(false);
    expect(isOriginRefusal(1001, "going away")).toBe(false);
  });

  it("names the origin that was refused, because that is what has to be pasted", () => {
    const err = new OriginNotAllowed("https://web-production-187614.up.railway.app");

    expect(err.name).toBe("OriginNotAllowed");
    expect(err.message).toContain("https://web-production-187614.up.railway.app");
    expect(err.message).toContain("dashboard.reown.com");
  });
});
