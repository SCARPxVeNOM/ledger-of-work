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

  it("refreshes one that cannot survive a phone approval", () => {
    // The expensive failure: alive at the check, dead by the time the signature returns,
    // so the buyer approves a payment for a job the seller has already deleted.
    expect(quoteIsStale(at(60_000), NOW)).toBe(true);
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

  it("leaves room for a human, but not the whole life of the quote", () => {
    // Unlocking a phone and approving does not fit in a few seconds. Nor may the margin
    // reach the seller's five-minute life, or every quote would refresh on sight.
    expect(QUOTE_REFRESH_MARGIN_MS).toBeGreaterThanOrEqual(60_000);
    expect(QUOTE_REFRESH_MARGIN_MS).toBeLessThan(5 * 60_000);
  });
});
