import { describe, expect, it } from "vitest";
import { assertValidUnits, RESERVED_UNITS } from "../src/units.js";

/**
 * What a receipt may call the things it counts.
 *
 * The caps are not tidiness. A receipt has 1024 bytes, and a key name is spent from the
 * same budget as the sources list — so an unbounded schema moves "this receipt cannot be
 * published" from a unit test to a paid job, in front of a buyer who has already paid.
 */
describe("work unit names", () => {
  it("accepts the reserved names an existing receipt uses", () => {
    expect(() => assertValidUnits({ steps: 2, pages: 1, sessionMs: 343 }, "unit")).not.toThrow();
    expect(RESERVED_UNITS).toContain("sessionMs");
  });

  it("accepts names a metered service would choose", () => {
    expect(() => assertValidUnits({ tokens: 12400, gpuMs: 830 }, "unit")).not.toThrow();
  });

  it("refuses more than four units, naming the limit", () => {
    expect(() => assertValidUnits({ a: 1, b: 2, c: 3, d: 4, e: 5 }, "unit")).toThrow(/at most 4/);
  });

  it("refuses a name too long to be cheap", () => {
    expect(() => assertValidUnits({ thisNameIsFarTooLong: 1 }, "unit")).toThrow(/12 characters/);
  });

  it("refuses names that are not plain identifiers", () => {
    // A name carrying a quote or a brace costs extra bytes once JSON-escaped, and reads
    // as an injection attempt in anything that renders the receipt.
    expect(() => assertValidUnits({ "a b": 1 }, "unit")).toThrow(/letters and digits/);
    expect(() => assertValidUnits({ "1st": 1 }, "unit")).toThrow(/letters and digits/);
  });

  it("refuses values that are not countable", () => {
    expect(() => assertValidUnits({ tokens: -1 }, "unit")).toThrow(/non-negative/);
    expect(() => assertValidUnits({ tokens: 1.5 }, "unit")).toThrow(/non-negative/);
  });

  it("says which kind it is complaining about", () => {
    expect(() => assertValidUnits({ a: 1, b: 2, c: 3, d: 4, e: 5 }, "artifact")).toThrow(/artifact/);
  });
});
