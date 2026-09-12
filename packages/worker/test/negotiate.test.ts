import { describe, expect, it } from "vitest";
import { priceTinybars } from "@low/protocol";
import { fitToBudget, offerFor } from "../src/negotiate.js";
import { CATALOGUE } from "../src/index.js";
import type { SiteAdapter } from "../src/types.js";

/**
 * Negotiating scope, never price.
 *
 * The price is a pure function of the work and a price book published before the job ran,
 * and the verifier checks it — so a counter-offer that shaded the rate would produce a
 * receipt that fails its own audit. Every test here exists to hold that line: the seller
 * may offer to do *less*, and may never offer to charge less for the same work.
 */

const quotes = CATALOGUE["quotes.search_and_extract"] as SiteAdapter<
  { tag?: string; max: number; login?: boolean },
  unknown
>;
/**
 * Unfiltered, so the price genuinely climbs with scope.
 *
 * Filtering by tag caps the result set at about twenty, which makes the price plateau —
 * a hundred records costs the same as forty because there are not a hundred to fetch.
 * That plateau is real behaviour and is tested below, but it is the wrong fixture for
 * "does the search find the largest job that fits".
 */
const params = (max: number) => quotes.normalise({ max });

/** Price straight from the price book, so a test cannot agree with a bug in the code. */
function bookPrice(p: ReturnType<typeof params>): string {
  const plan = quotes.plan(p);
  return priceTinybars(
    { steps: plan.steps, pages: plan.pages, sessionMs: plan.estimatedMs },
    quotes.spec.priceBook,
  );
}

describe("a budget that already covers the job", () => {
  it("is accepted unchanged, with no attempt to sell more", () => {
    const asked = params(3);
    const full = bookPrice(asked);
    const fit = fitToBudget(quotes, asked, String(BigInt(full) * 10n));

    expect(fit.kind).toBe("fits");
    if (fit.kind !== "fits") return;
    expect(fit.offer.priceTinybar).toBe(full);
    // Generosity is not an invitation to upsell — the scope asked for is the scope quoted.
    expect(fit.offer.params.max).toBe(asked.max);
  });

  it("is accepted when the budget matches the price exactly", () => {
    const asked = params(3);
    const fit = fitToBudget(quotes, asked, bookPrice(asked));

    expect(fit.kind).toBe("fits");
  });
});

describe("a budget that does not cover the job", () => {
  it("comes back as less work, never as a discount", () => {
    const asked = params(100);
    const budget = bookPrice(params(10));
    const fit = fitToBudget(quotes, asked, budget);

    expect(fit.kind).toBe("counter");
    if (fit.kind !== "counter") return;

    // The counter is smaller than what was asked for...
    expect(fit.offer.params.max).toBeLessThan(asked.max);
    // ...and is priced at the published rate for that smaller scope, to the tinybar.
    expect(fit.offer.priceTinybar).toBe(bookPrice(fit.offer.params));
    expect(BigInt(fit.offer.priceTinybar)).toBeLessThanOrEqual(BigInt(budget));
  });

  it("offers the largest scope that fits, not merely one that does", () => {
    const asked = params(100);
    const budget = bookPrice(params(20));
    const fit = fitToBudget(quotes, asked, budget);

    expect(fit.kind).toBe("counter");
    if (fit.kind !== "counter") return;

    // One more record than offered must break the budget, or the seller under-sold.
    const oneMore = bookPrice(params(fit.offer.params.max + 1));
    expect(BigInt(oneMore)).toBeGreaterThan(BigInt(budget));
  });

  it("reports what was asked for alongside what is offered", () => {
    // The buyer needs both numbers to decide whether the smaller job is worth having.
    const asked = params(100);
    const fit = fitToBudget(quotes, asked, bookPrice(params(10)));

    expect(fit.kind).toBe("counter");
    if (fit.kind !== "counter") return;
    expect(fit.asked.params.max).toBe(100);
    expect(fit.asked.priceTinybar).toBe(bookPrice(asked));
    expect(BigInt(fit.asked.priceTinybar)).toBeGreaterThan(BigInt(fit.offer.priceTinybar));
  });
});

describe("where the price plateaus", () => {
  /**
   * The site returns ten records a page, so scope only costs more when it crosses a page
   * boundary: ten records and one record cost the same. A buyer who is paying for that
   * page should be given all of it.
   */
  it("hands over the whole page the buyer has already paid for", () => {
    const budget = bookPrice(params(1));
    const fit = fitToBudget(quotes, params(100), budget);

    expect(fit.kind).toBe("counter");
    if (fit.kind !== "counter") return;
    // Not 1, which also fits and would be the answer a naive downward walk stopped at.
    expect(fit.offer.params.max).toBe(10);
    expect(fit.offer.priceTinybar).toBe(budget);
  });

  it("does not counter-offer when the asked-for scope is already inside the plateau", () => {
    // Twenty records and a hundred cost the same when only twenty exist to fetch, so a
    // budget covering twenty covers the hundred that was asked for. Trimming the request
    // here would be officious rather than honest.
    const tagged = (max: number) => quotes.normalise({ tag: "love", max });
    const plan = quotes.plan(tagged(20));
    const budget = priceTinybars(
      { steps: plan.steps, pages: plan.pages, sessionMs: plan.estimatedMs },
      quotes.spec.priceBook,
    );

    expect(fitToBudget(quotes, tagged(100), budget).kind).toBe("fits");
  });
});

describe("a budget nothing fits", () => {
  it("is refused with the floor price, rather than counter-offered", () => {
    // One tinybar buys nothing here; the honest answer is what the smallest job costs.
    const fit = fitToBudget(quotes, params(100), "1");

    expect(fit.kind).toBe("no-fit");
    if (fit.kind !== "no-fit") return;
    expect(fit.reason).toBe("floor-above-budget");
    expect(fit.floor.priceTinybar).toBe(bookPrice(params(1)));
  });

  it("refuses rather than quietly returning the full-price job", () => {
    // The failure that matters: an agent says "I have 1 tinybar", and a careless
    // implementation hands back the unchanged quote, which it then pays.
    const fit = fitToBudget(quotes, params(100), "1");

    expect(fit.kind).not.toBe("fits");
  });
});

describe("a capability with no scope dial", () => {
  it("is reported as not divisible instead of being trimmed", () => {
    const indivisible = {
      ...quotes,
      // Same pricing, but the parameters carry nothing that means "how much".
      plan: () => quotes.plan(params(50)),
    } as unknown as SiteAdapter<Record<string, unknown>, unknown>;

    const fit = fitToBudget(indivisible, { tag: "love" }, "1");

    expect(fit.kind).toBe("no-fit");
    if (fit.kind !== "no-fit") return;
    expect(fit.reason).toBe("not-divisible");
  });
});

describe("every capability in the catalogue", () => {
  // The negotiation endpoint offers all of them, so all of them must be negotiable.
  for (const [name, adapter] of Object.entries(CATALOGUE)) {
    it(`${name} prices a plan and can be fitted to a budget`, () => {
      const a = adapter as SiteAdapter<Record<string, unknown>, unknown>;
      const p = a.normalise({
        // Each adapter ignores the parameters it does not use; `max` is the one they share.
        max: 25,
        tag: "love",
        query: "climate change",
        year: 2025,
        month: 1,
        url: "https://www.whitehouse.gov/presidential-actions/",
        select: ".wp-block-post-title",
      });
      const full = offerFor(a, p);
      expect(BigInt(full.priceTinybar)).toBeGreaterThan(0n);

      // Half the money must never buy more than the whole job.
      const half = String(BigInt(full.priceTinybar) / 2n);
      const fit = fitToBudget(a, p, half);
      expect(fit.kind).not.toBe("fits");
      if (fit.kind === "counter") {
        expect(BigInt(fit.offer.priceTinybar)).toBeLessThanOrEqual(BigInt(half));
      }
    });
  }
});
