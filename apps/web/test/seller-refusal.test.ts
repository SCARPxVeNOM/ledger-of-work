import { describe, expect, it } from "vitest";
import { sellerRefusal } from "../src/main.js";

/**
 * What the buyer is told when the seller says no.
 *
 * The bug these pin: a quote lives five minutes, and pairing a wallet can spend most of
 * that. Someone approved a pairing, pressed pay, and got "502 Bad Gateway" — while the
 * seller had answered `404 unknown_or_expired_quote` with "request a fresh quote", which
 * is exactly the sentence they needed and the only one they did not see.
 */
describe("sellerRefusal", () => {
  const expired = { error: "unknown_or_expired_quote", message: "request a fresh quote" };

  it("passes the seller's own sentence through", () => {
    expect(sellerRefusal(404, expired).error).toBe("request a fresh quote");
  });

  it("keeps the machine-readable code so the page can re-quote by itself", () => {
    expect(sellerRefusal(404, expired).code).toBe("unknown_or_expired_quote");
  });

  it("calls a lapsed quote gone, not a bad gateway", () => {
    // 410 is the difference between "this is over, ask again" and "something is broken".
    expect(sellerRefusal(404, expired).status).toBe(410);
  });

  it("still reports a seller fault as a gateway failure", () => {
    expect(sellerRefusal(500, null).status).toBe(502);
    expect(sellerRefusal(503, null).status).toBe(502);
  });

  it("leaves other refusals at the status the seller chose", () => {
    // A 400 is the buyer's to fix and already says so; rewriting it would only obscure.
    expect(sellerRefusal(400, { error: "bad_params" }).status).toBe(400);
  });

  it("says something useful when the seller explains nothing", () => {
    const out = sellerRefusal(418, null);

    expect(out.error).toContain("418");
    expect(out.code).toBeUndefined();
  });

  it("falls back to the code when there is no prose", () => {
    expect(sellerRefusal(409, { error: "quote_already_used" }).error).toBe("quote_already_used");
  });
});
