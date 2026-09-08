import { describe, expect, it } from "vitest";
import { price } from "@low/protocol";
import { MAX_SOURCES, WorkMeter } from "../src/meter.js";
import { JobAbortedError } from "../src/types.js";
import { booksAdapter } from "../src/adapters/books.js";
import { quotesAdapter } from "../src/adapters/quotes.js";
import { CATALOGUE } from "../src/index.js";
import { PRICE_BOOKS } from "../src/pricebooks.js";

const LIMITS = { maxSteps: 5, maxPages: 3, maxSessionMs: 10_000 };

/** A clock we control, so ceiling tests are not flaky and do not sleep. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("WorkMeter", () => {
  it("counts a step per wrapped action", async () => {
    const m = new WorkMeter({ limits: LIMITS, now: fakeClock().now });
    await m.step("a", async () => 1);
    await m.step("b", async () => 2);
    expect(m.snapshot().steps).toBe(2);
  });

  it("counts a step even when the action throws", async () => {
    // Otherwise a flow could do unbounded work by failing repeatedly and never being
    // charged or stopped for it.
    const m = new WorkMeter({ limits: LIMITS, now: fakeClock().now });
    await expect(m.step("boom", async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    expect(m.snapshot().steps).toBe(1);
  });

  it("counts pages and records their URLs as sources", () => {
    const m = new WorkMeter({ limits: LIMITS, now: fakeClock().now });
    m.countPage("https://example.com/1");
    m.countPage("https://example.com/2");
    const w = m.snapshot();
    expect(w.pages).toBe(2);
    expect(w.sources).toEqual(["https://example.com/1", "https://example.com/2"]);
  });

  it("does not record the same source twice", () => {
    const m = new WorkMeter({ limits: LIMITS, now: fakeClock().now });
    m.addSource("https://example.com/x");
    m.addSource("https://example.com/x");
    expect(m.snapshot().sources).toHaveLength(1);
  });

  it("bounds sources so a receipt stays inside one HCS chunk", () => {
    const m = new WorkMeter({ limits: { ...LIMITS, maxPages: 100 }, now: fakeClock().now });
    for (let i = 0; i < MAX_SOURCES + 5; i++) m.addSource(`https://example.com/${i}`);
    expect(m.snapshot().sources).toHaveLength(MAX_SOURCES);
    expect(m.truncatedSources).toBe(5);
  });

  it("measures session time from the injected clock", () => {
    const clock = fakeClock();
    const m = new WorkMeter({ limits: LIMITS, now: clock.now });
    clock.advance(2_500);
    expect(m.snapshot().sessionMs).toBe(2_500);
  });
});

describe("ceilings — the only thing standing between a runaway flow and a loss", () => {
  it("aborts once the step ceiling is crossed", async () => {
    const m = new WorkMeter({ limits: LIMITS, now: fakeClock().now });
    for (let i = 0; i < LIMITS.maxSteps; i++) await m.step(`s${i}`, async () => i);
    await expect(m.step("one too many", async () => 0)).rejects.toBeInstanceOf(JobAbortedError);
  });

  it("aborts once the page ceiling is crossed", () => {
    const m = new WorkMeter({ limits: LIMITS, now: fakeClock().now });
    for (let i = 0; i <= LIMITS.maxPages; i++) m.countPage(`https://example.com/${i}`);
    expect(() => m.assertWithinLimits()).toThrow(JobAbortedError);
  });

  it("aborts once the time ceiling is crossed", () => {
    const clock = fakeClock();
    const m = new WorkMeter({ limits: LIMITS, now: clock.now });
    clock.advance(LIMITS.maxSessionMs + 1);
    expect(() => m.assertWithinLimits()).toThrow(/time ceiling/);
  });

  it("reports which ceiling broke and the work done, so a failed receipt is still honest", async () => {
    const m = new WorkMeter({ limits: { ...LIMITS, maxSteps: 1 }, now: fakeClock().now });
    await m.step("first", async () => 0);
    try {
      await m.step("second", async () => 0);
      expect.unreachable();
    } catch (err) {
      const aborted = err as JobAbortedError;
      expect(aborted.reason).toBe("steps");
      expect(aborted.work.steps).toBe(2);
    }
  });
});

describe("plans price the way the meter will", () => {
  it("a bigger quotes job plans more work and therefore costs more", () => {
    const small = quotesAdapter.plan(quotesAdapter.normalise({ tag: "love", max: 3 }));
    const large = quotesAdapter.plan(quotesAdapter.normalise({ tag: "love", max: 60 }));
    expect(large.steps).toBeGreaterThan(small.steps);
    expect(large.pages).toBeGreaterThan(small.pages);

    const book = quotesAdapter.spec.priceBook;
    const p = (pl: typeof small) =>
      price({ steps: pl.steps, pages: pl.pages, sessionMs: pl.estimatedMs }, book).total;
    expect(p(large)).toBeGreaterThan(p(small));
  });

  it("skipping the login saves the buyer two steps", () => {
    const withLogin = quotesAdapter.plan(quotesAdapter.normalise({ tag: "love", max: 10 }));
    const without = quotesAdapter.plan(
      quotesAdapter.normalise({ tag: "love", max: 10, login: false }),
    );
    expect(withLogin.steps - without.steps).toBe(2);
  });

  it("is pure — planning the same params twice gives the same answer", () => {
    const params = booksAdapter.normalise({ category: "travel", maxPrice: 20, minRating: 4 });
    expect(booksAdapter.plan(params)).toEqual(booksAdapter.plan(params));
  });

  it("a stricter rating filter plans more pages, because fewer books match per page", () => {
    // nonfiction is 110 books over 6 pages, so there is room for the filter to matter.
    const loose = booksAdapter.plan(booksAdapter.normalise({ category: "nonfiction", max: 20 }));
    const strict = booksAdapter.plan(
      booksAdapter.normalise({ category: "nonfiction", max: 20, minRating: 4 }),
    );
    expect(strict.pages).toBeGreaterThan(loose.pages);
  });

  it("never plans more pages than the category actually has", () => {
    // travel is 11 books — a single page. Quoting for six would overcharge by 5x.
    const p = booksAdapter.plan(
      booksAdapter.normalise({ category: "travel", max: 100, minRating: 5 }),
    );
    expect(p.pages).toBe(1);
  });

  it("never plans beyond its own page ceiling", () => {
    const p = booksAdapter.plan(
      booksAdapter.normalise({ category: "nonfiction", max: 100, minRating: 5 }),
    );
    expect(p.pages).toBeLessThanOrEqual(booksAdapter.spec.limits.maxPages);
  });

  it("does not quote a tagged quotes job for pages a tag cannot have", () => {
    // Every tag on the live site caps out at two pages; asking for 100 must not quote
    // for ten. This was a real overcharge before the ceiling was measured.
    const tagged = quotesAdapter.plan(quotesAdapter.normalise({ tag: "love", max: 100 }));
    const all = quotesAdapter.plan(quotesAdapter.normalise({ max: 100 }));
    expect(tagged.pages).toBe(2);
    expect(all.pages).toBe(10);
  });

  it("returns an outline a buyer can read before paying", () => {
    const p = quotesAdapter.plan(quotesAdapter.normalise({ tag: "love", max: 25 }));
    expect(p.outline[0]).toBe("open login form");
    expect(p.outline.join(" ")).toContain("paginate to page 2");
  });
});

describe("parameter validation", () => {
  it("rejects a tag that is not a plain slug", () => {
    expect(() => quotesAdapter.normalise({ tag: "../../etc/passwd" })).toThrow(/tag/);
    expect(() => quotesAdapter.normalise({ tag: "love page/2" })).toThrow(/tag/);
    expect(() => quotesAdapter.normalise({ tag: 42 })).toThrow(/tag/);
  });

  it("treats an absent or empty tag as browsing the whole listing", () => {
    expect(quotesAdapter.normalise({}).tag).toBeNull();
    expect(quotesAdapter.normalise({ tag: "" }).tag).toBeNull();
    expect(quotesAdapter.normalise({ tag: null }).tag).toBeNull();
  });

  it("rejects out-of-range result counts", () => {
    expect(() => quotesAdapter.normalise({ tag: "love", max: 0 })).toThrow(/max/);
    expect(() => quotesAdapter.normalise({ tag: "love", max: 101 })).toThrow(/max/);
    expect(() => quotesAdapter.normalise({ tag: "love", max: 2.5 })).toThrow(/max/);
  });

  it("rejects a category outside the fixed catalogue", () => {
    expect(() => booksAdapter.normalise({ category: "not-a-category" })).toThrow(/category/);
  });

  it("normalises case and whitespace", () => {
    expect(quotesAdapter.normalise({ tag: "  LOVE  " }).tag).toBe("love");
    expect(booksAdapter.normalise({ category: " Travel " }).category).toBe("travel");
  });

  it("applies documented defaults", () => {
    const q = quotesAdapter.normalise({ tag: "love" });
    expect(q).toEqual({ tag: "love", max: 10, login: true });
  });
});

describe("published price books", () => {
  it("match every adapter's own price book exactly", () => {
    // The verifier reads PRICE_BOOKS while the seller charges from spec.priceBook. If
    // they drift, the meter check verifies against a price nobody was charged — which
    // would be a verifier that passes on a receipt it should reject.
    for (const [name, adapter] of Object.entries(CATALOGUE)) {
      expect(PRICE_BOOKS[name], `no published price book for ${name}`).toEqual(
        adapter.spec.priceBook,
      );
    }
  });

  it("publishes a book for every capability and no extras", () => {
    expect(Object.keys(PRICE_BOOKS).sort()).toEqual(Object.keys(CATALOGUE).sort());
  });
});
