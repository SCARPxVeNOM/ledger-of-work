import { describe, expect, it } from "vitest";
import {
  HBAR,
  HBAR_ASSET,
  formatAssetAmount,
  isHbar,
  tinybarToAssetUnits,
  type AssetSpec,
} from "../src/assets.js";

/**
 * WORK: two decimals, at 0.001 smallest-units per tinybar.
 *
 * So 100,000 tinybar (0.001 HBAR) buys 100 units = 1.00 WORK, and the 312,000-tinybar
 * quote measured on testnet comes to 3.12 WORK.
 */
const WORK: AssetSpec = {
  id: "0.0.10416991",
  symbol: "WORK",
  decimals: 2,
  unitsPerTinybar: "0.001",
};

describe("asset identity", () => {
  it("recognises HBAR by its x402 spelling", () => {
    expect(isHbar(HBAR_ASSET)).toBe(true);
    expect(isHbar("0.0.0")).toBe(true);
    expect(isHbar("0.0.10416991")).toBe(false);
  });
});

describe("tinybarToAssetUnits", () => {
  it("is the identity for HBAR", () => {
    expect(tinybarToAssetUnits("312000", HBAR)).toBe("312000");
    expect(tinybarToAssetUnits(0n, HBAR)).toBe("0");
  });

  it("converts a real quote into token units", () => {
    // 312,000 tinybar * 0.001 = 312 smallest units = 3.12 WORK
    expect(tinybarToAssetUnits("312000", WORK)).toBe("312");
    expect(formatAssetAmount("312", WORK)).toBe("3.12 WORK");
  });

  it("rounds up, never down", () => {
    // The exact scheme rejects a payment crediting less than `amount`, so rounding down
    // would under-bill and then fail settlement. Up costs at most one unit.
    expect(tinybarToAssetUnits("1", WORK)).toBe("1");      // 0.001 -> 1
    expect(tinybarToAssetUnits("99999", WORK)).toBe("100"); // 99.999 -> 100
    expect(tinybarToAssetUnits("100001", WORK)).toBe("101"); // 100.001 -> 101
  });

  it("is exact on multiples of the rate", () => {
    expect(tinybarToAssetUnits("100000", WORK)).toBe("100");
  });

  it("stays in integers — no float drift at large amounts", () => {
    const huge = "123456789012345";
    const out = tinybarToAssetUnits(huge, WORK);
    expect(/^\d+$/.test(out)).toBe(true);
    expect(out).toBe("123456789013");
  });

  it("handles a whole-number rate", () => {
    const cents: AssetSpec = { id: "0.0.1", symbol: "C", decimals: 0, unitsPerTinybar: "3" };
    expect(tinybarToAssetUnits("7", cents)).toBe("21");
  });

  it("is monotonic — a bigger job never costs fewer units", () => {
    let prev = -1n;
    for (const t of ["0", "1", "500", "99999", "100000", "312000", "1572000"]) {
      const u = BigInt(tinybarToAssetUnits(t, WORK));
      expect(u).toBeGreaterThanOrEqual(prev);
      prev = u;
    }
  });

  it("rejects a negative amount rather than producing a nonsense price", () => {
    expect(() => tinybarToAssetUnits("-1", WORK)).toThrow(/negative/);
  });
});

describe("formatAssetAmount", () => {
  it("pads the fractional part", () => {
    expect(formatAssetAmount("5", WORK)).toBe("0.05 WORK");
    expect(formatAssetAmount("100000", WORK)).toBe("1000.00 WORK");
  });

  it("handles a zero-decimal asset", () => {
    expect(formatAssetAmount("42", { id: "0.0.1", symbol: "X", decimals: 0, unitsPerTinybar: "1" })).toBe(
      "42 X",
    );
  });
});
