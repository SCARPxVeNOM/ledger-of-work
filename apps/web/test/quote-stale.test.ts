import { describe, expect, it } from "vitest";
import { QUOTE_REFRESH_MARGIN_MS, quoteIsStale } from "../src/ui/quote.js";

/**
 * When Pay and run should fetch a new quote before paying.
 *
 * The failure this prevents: a quote lives five minutes at the seller, pairing a wallet
 * can eat most of that, and the moment it lapses the run url and the event stream both
 * 404. The buyer's whole experience was approving a pairing, pressing pay, and reading
 * "502 Bad Gateway".
 */
const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

describe("quoteIsStale", () => {
  it("spends a quote with plenty of life left", () => {
    expect(quoteIsStale(at(5 * 60_000), NOW)).toBe(false);
  });

  it("refreshes one that has already lapsed", () => {
    expect(quoteIsStale(at(-1), NOW)).toBe(true);
  });

  it("refreshes one that expires during the approval it is about to wait for", () => {
    // Alive right now, and dead by the time a signature comes back from a phone. Paying
    // against this is the 404 the fix exists to avoid.
    expect(quoteIsStale(at(QUOTE_REFRESH_MARGIN_MS - 1), NOW)).toBe(true);
  });

  it("keeps one that clears the margin by a hair", () => {
    expect(quoteIsStale(at(QUOTE_REFRESH_MARGIN_MS + 1), NOW)).toBe(false);
  });

  it("treats an unusable expiry as stale rather than assuming it is good", () => {
    // Guessing "fresh" costs the buyer a failed payment; guessing "stale" costs a request.
    expect(quoteIsStale(undefined, NOW)).toBe(true);
    expect(quoteIsStale("", NOW)).toBe(true);
    expect(quoteIsStale("whenever", NOW)).toBe(true);
  });

  it("leaves a real margin, not a token one", () => {
    // A signature round trip through a phone does not fit in a second.
    expect(QUOTE_REFRESH_MARGIN_MS).toBeGreaterThanOrEqual(10_000);
  });
});
