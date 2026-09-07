import { describe, expect, it } from "vitest";
import { price, priceTinybars } from "../src/price.js";
import { EXPECTED_CHARGE, PRICE_BOOK } from "./fixtures.js";

describe("the meter", () => {
  it("prices the worked example the way the published book says", () => {
    const b = price({ steps: 7, pages: 2, sessionMs: 6768 }, PRICE_BOOK);
    expect(b.base).toBe(50_000n);
    expect(b.steps).toBe(70_000n);
    expect(b.pages).toBe(50_000n);
    expect(b.seconds).toBe(14_000n); // ceil(6.768) = 7 seconds
    expect(b.total.toString()).toBe(EXPECTED_CHARGE);
  });

  it("is deterministic — the same work always prices the same", () => {
    const work = { steps: 4, pages: 1, sessionMs: 3200 };
    const runs = Array.from({ length: 50 }, () => priceTinybars(work, PRICE_BOOK));
    expect(new Set(runs).size).toBe(1);
  });

  it("charges less for less work — this is the whole premise", () => {
    const short = priceTinybars({ steps: 2, pages: 1, sessionMs: 1500 }, PRICE_BOOK);
    const long = priceTinybars({ steps: 9, pages: 4, sessionMs: 12000 }, PRICE_BOOK);
    expect(BigInt(long)).toBeGreaterThan(BigInt(short));
  });

  it("is monotonic in every dimension", () => {
    const base = { steps: 3, pages: 2, sessionMs: 4000 };
    const p = (w: typeof base) => BigInt(priceTinybars(w, PRICE_BOOK));
    expect(p({ ...base, steps: 4 })).toBeGreaterThan(p(base));
    expect(p({ ...base, pages: 3 })).toBeGreaterThan(p(base));
    expect(p({ ...base, sessionMs: 5000 })).toBeGreaterThan(p(base));
  });

  it("bills part-seconds as whole seconds, so a job cannot dodge the time component", () => {
    const p = (ms: number) => price({ steps: 0, pages: 0, sessionMs: ms }, PRICE_BOOK).seconds;
    expect(p(1)).toBe(2_000n);
    expect(p(1000)).toBe(2_000n);
    expect(p(1001)).toBe(4_000n);
    expect(p(0)).toBe(0n);
  });

  it("never exceeds the published ceiling", () => {
    const runaway = { steps: 10_000, pages: 5_000, sessionMs: 600_000 };
    const b = price(runaway, PRICE_BOOK);
    expect(b.subtotal).toBeGreaterThan(BigInt(PRICE_BOOK.ceiling));
    expect(b.total).toBe(BigInt(PRICE_BOOK.ceiling));
    expect(b.ceilingHit).toBe(true);
  });

  it("does not report a ceiling hit when the price fits", () => {
    expect(price({ steps: 1, pages: 1, sessionMs: 1000 }, PRICE_BOOK).ceilingHit).toBe(false);
  });

  it("stays in integer tinybars — no float can creep into a price", () => {
    const book = { ...PRICE_BOOK, perSecond: "1", perStep: "1", perPage: "1", base: "0" };
    // 0.1 + 0.2 style drift would show up here if any step used Number arithmetic.
    const total = price({ steps: 3, pages: 3, sessionMs: 3000 }, book).total;
    expect(total).toBe(9n);
    expect(typeof total).toBe("bigint");
  });

  it("rejects work counts that are not countable", () => {
    expect(() => price({ steps: 1.5, pages: 0, sessionMs: 0 }, PRICE_BOOK)).toThrow(/steps/);
    expect(() => price({ steps: -1, pages: 0, sessionMs: 0 }, PRICE_BOOK)).toThrow(/steps/);
    expect(() => price({ steps: 0, pages: Number.NaN, sessionMs: 0 }, PRICE_BOOK)).toThrow(/pages/);
  });
});
