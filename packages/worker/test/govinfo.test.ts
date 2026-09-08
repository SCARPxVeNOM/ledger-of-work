import { describe, expect, it } from "vitest";
import { govinfoAdapter, parseDayLabel } from "../src/adapters/govinfo.js";

// Labels copied verbatim from the live site, newlines and en dash included.
const LABEL = "Thursday, January 2 – \nPages 1-183";
const LABEL_2 = "Wednesday, January 15 – \nPages 3601-4584";

describe("parseDayLabel", () => {
  it("reads the date and page range from a real label", () => {
    expect(parseDayLabel(LABEL, 2025)).toEqual({
      date: "2025-01-02",
      weekday: "Thursday",
      pageStart: 1,
      pageEnd: 183,
      pageCount: 183,
    });
  });

  it("zero-pads single-digit days so dates sort lexically", () => {
    expect(parseDayLabel(LABEL, 2025)?.date).toBe("2025-01-02");
    expect(parseDayLabel(LABEL_2, 2025)?.date).toBe("2025-01-15");
  });

  it("computes the page count inclusively", () => {
    // Pages 1-183 is 183 pages, not 182.
    expect(parseDayLabel(LABEL, 2025)?.pageCount).toBe(183);
    expect(parseDayLabel(LABEL_2, 2025)?.pageCount).toBe(984);
  });

  it("does not confuse the label's en dash with the page range's hyphen", () => {
    // Splitting naively on "-" would cut "Pages 1-183" in half and lose the range.
    const parsed = parseDayLabel(LABEL, 2025);
    expect(parsed?.pageStart).toBe(1);
    expect(parsed?.pageEnd).toBe(183);
  });

  it("survives the embedded newline the site renders", () => {
    expect(parseDayLabel(LABEL, 2025)).not.toBeNull();
    expect(parseDayLabel("Friday, January 3 –\nPages 185-528", 2025)?.pageEnd).toBe(528);
  });

  it("handles every month name", () => {
    for (const [i, m] of [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ].entries()) {
      const got = parseDayLabel(`Monday, ${m} 7 – Pages 1-2`, 2024);
      expect(got?.date).toBe(`2024-${String(i + 1).padStart(2, "0")}-07`);
    }
  });

  it("returns null for labels that are not days", () => {
    expect(parseDayLabel("2025 (Volume 90)", 2025)).toBeNull();
    expect(parseDayLabel("January", 2025)).toBeNull();
    expect(parseDayLabel("", 2025)).toBeNull();
    expect(parseDayLabel("Browse", 2025)).toBeNull();
  });

  it("still yields a date when the page range is missing", () => {
    // An issue with no printed range is unusual but not a parse failure.
    const got = parseDayLabel("Monday, March 3 –", 2025);
    expect(got?.date).toBe("2025-03-03");
    expect(got?.pageStart).toBeNull();
    expect(got?.pageCount).toBeNull();
  });
});

describe("govinfo parameters", () => {
  it("rejects a year before the Federal Register existed", () => {
    expect(() => govinfoAdapter.normalise({ year: 1935, month: 1 })).toThrow(/year/);
  });

  it("rejects a year in the future", () => {
    const next = new Date().getUTCFullYear() + 1;
    expect(() => govinfoAdapter.normalise({ year: next, month: 1 })).toThrow(/year/);
  });

  it("rejects an impossible month", () => {
    expect(() => govinfoAdapter.normalise({ year: 2025, month: 0 })).toThrow(/month/);
    expect(() => govinfoAdapter.normalise({ year: 2025, month: 13 })).toThrow(/month/);
  });

  it("caps max at the longest possible month", () => {
    expect(() => govinfoAdapter.normalise({ year: 2025, month: 1, max: 32 })).toThrow(/max/);
    expect(govinfoAdapter.normalise({ year: 2025, month: 1, max: 31 }).max).toBe(31);
  });
});

describe("govinfo plan", () => {
  it("is fixed depth — the tree is always open, year, month", () => {
    const small = govinfoAdapter.plan(govinfoAdapter.normalise({ year: 2025, month: 1, max: 2 }));
    const large = govinfoAdapter.plan(govinfoAdapter.normalise({ year: 2025, month: 1, max: 31 }));
    expect(small.steps).toBe(3);
    expect(large.steps).toBe(3);
  });

  it("is pure", () => {
    const p = govinfoAdapter.normalise({ year: 2025, month: 3 });
    expect(govinfoAdapter.plan(p)).toEqual(govinfoAdapter.plan(p));
  });

  it("names the month a buyer asked for, so the quote is legible", () => {
    const p = govinfoAdapter.plan(govinfoAdapter.normalise({ year: 2025, month: 3 }));
    expect(p.outline.join(" ")).toContain("expand March");
    expect(p.outline.join(" ")).toContain("expand 2025");
  });

  it("stays inside its own step ceiling", () => {
    const p = govinfoAdapter.plan(govinfoAdapter.normalise({ year: 2025, month: 1, max: 31 }));
    expect(p.steps).toBeLessThanOrEqual(govinfoAdapter.spec.limits.maxSteps);
    expect(p.pages).toBeLessThanOrEqual(govinfoAdapter.spec.limits.maxPages);
  });
});
