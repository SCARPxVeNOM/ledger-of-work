import { describe, expect, it } from "vitest";
import { decideSettlement, quoteFor } from "../src/gate.js";

/**
 * The two decisions a gate makes that cost somebody money.
 *
 * Pricing happens before the work, from a book published before the request, so a buyer
 * can check the quote. Settlement happens after, and the interesting case is refusing to
 * charge — a service that bills for nothing is the failure this project already shipped
 * once, against a Cloudflare challenge page.
 */

const BOOK = {
  base: "1000",
  perStep: "0",
  perPage: "0",
  perSecond: "0",
  ceiling: "1000000",
  per: { tokens: "5" },
};

const config = {
  capability: "text.summarise",
  book: BOOK,
  price: (req: { body: unknown }) => ({ tokens: (req.body as { tokens: number }).tokens }),
  delivered: (out: { text: string }) =>
    out.text.length > 0
      ? ({ ok: true } as const)
      : ({ ok: false, why: "the model returned nothing. Nothing was charged." } as const),
};

describe("quoting before the work", () => {
  it("prices from the published book", () => {
    // base 1000 + 200 tokens at 5 = 2000
    expect(quoteFor(config, { body: { tokens: 200 } }).amount).toBe("2000");
  });

  it("reports the units it priced, so the receipt can record them", () => {
    expect(quoteFor(config, { body: { tokens: 200 } }).units).toEqual({ tokens: 200 });
  });

  it("refuses units the receipt schema could not carry", () => {
    // The moment to find this out is the first request, not the first oversized one.
    const tooMany = { ...config, price: () => ({ a: 1, b: 2, c: 3, d: 4, e: 5 }) };

    expect(() => quoteFor(tooMany, { body: {} })).toThrow(/at most 4/);
  });

  it("refuses a unit the book does not price", () => {
    const unpriced = { ...config, price: () => ({ widgets: 3 }) };

    expect(() => quoteFor(unpriced, { body: {} })).toThrow(/widgets/);
  });

  it("charges the base even for a request that consumes nothing", () => {
    // Answering costs something, and a zero-cost request is an invitation to loop.
    expect(quoteFor(config, { body: { tokens: 0 } }).amount).toBe("1000");
  });
});

describe("deciding whether to charge", () => {
  it("settles when the handler delivered something", () => {
    expect(decideSettlement(config, { text: "a summary" })).toEqual({ settle: true });
  });

  it("does not settle when it delivered nothing, and says why", () => {
    const decision = decideSettlement(config, { text: "" });

    expect(decision.settle).toBe(false);
    if (decision.settle) return;
    expect(decision.why).toMatch(/Nothing was charged/);
  });

  it("settles by default when the adopter declares no opinion", () => {
    // For a search, finding nothing is an answer, and making it free would let a buyer
    // take work for the price of a bad query. Only the adopter knows which they are.
    const { delivered: _none, ...noOpinion } = config;

    expect(decideSettlement(noOpinion, { text: "" })).toEqual({ settle: true });
  });
});
