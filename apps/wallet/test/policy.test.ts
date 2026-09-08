import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, SpendLedger, checkPolicy, type SpendPolicy } from "../src/policy.js";

const POLICY: SpendPolicy = {
  maxPerPayment: "500000",
  maxTotal: "1000000",
  allowedAssets: [],
  allowedRecipients: [],
};

const pay = (over: Partial<{ amount: string; asset: string; payTo: string }> = {}) => ({
  amount: "300000",
  asset: "0.0.0",
  payTo: "0.0.10410493",
  ...over,
});

describe("spend policy", () => {
  it("allows a payment inside every limit", () => {
    expect(checkPolicy(pay(), POLICY, 0n)).toEqual({ allowed: true });
  });

  it("refuses a payment over the per-payment ceiling", () => {
    const v = checkPolicy(pay({ amount: "500001" }), POLICY, 0n);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/per-payment limit/);
  });

  it("allows a payment exactly at the ceiling", () => {
    expect(checkPolicy(pay({ amount: "500000" }), POLICY, 0n).allowed).toBe(true);
  });

  it("counts the current payment towards the total, not just prior spend", () => {
    // Otherwise a single large payment vaults straight over the cap: prior spend is
    // under the limit, so the check passes, and the limit never bound anything.
    const v = checkPolicy(pay({ amount: "400000" }), POLICY, 700_000n);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/total spend/);
  });

  it("allows spend that lands exactly on the total", () => {
    expect(checkPolicy(pay({ amount: "300000" }), POLICY, 700_000n).allowed).toBe(true);
  });

  it("defaults to HBAR only, refusing an unlisted token", () => {
    const v = checkPolicy(pay({ asset: "0.0.10416991" }), POLICY, 0n);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/not in this wallet's allowed list/);
  });

  it("allows a token once it is listed", () => {
    const p = { ...POLICY, allowedAssets: ["0.0.10416991"] };
    expect(checkPolicy(pay({ asset: "0.0.10416991" }), p, 0n).allowed).toBe(true);
    // And listing a token does not silently keep HBAR allowed.
    expect(checkPolicy(pay({ asset: "0.0.0" }), p, 0n).allowed).toBe(false);
  });

  it("restricts recipients when a list is given", () => {
    const p = { ...POLICY, allowedRecipients: ["0.0.10410493"] };
    expect(checkPolicy(pay(), p, 0n).allowed).toBe(true);
    const v = checkPolicy(pay({ payTo: "0.0.999" }), p, 0n);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/allowed recipient/);
  });

  it("refuses nonsense amounts rather than signing them", () => {
    expect(checkPolicy(pay({ amount: "0" }), POLICY, 0n).allowed).toBe(false);
    expect(checkPolicy(pay({ amount: "-5" }), POLICY, 0n).allowed).toBe(false);
    expect(checkPolicy(pay({ amount: "1.5" }), POLICY, 0n).allowed).toBe(false);
    expect(checkPolicy(pay({ amount: "abc" }), POLICY, 0n).allowed).toBe(false);
  });

  it("ships with limits that actually bind", () => {
    // A default policy of "unlimited" would make the wallet a signing oracle.
    expect(BigInt(DEFAULT_POLICY.maxPerPayment)).toBeGreaterThan(0n);
    expect(BigInt(DEFAULT_POLICY.maxTotal)).toBeGreaterThanOrEqual(
      BigInt(DEFAULT_POLICY.maxPerPayment),
    );
  });
});

describe("spend ledger", () => {
  it("accumulates per asset", () => {
    const l = new SpendLedger();
    l.record("0.0.0", "100");
    l.record("0.0.0", "250");
    l.record("0.0.10416991", "7");
    expect(l.spent("0.0.0")).toBe(350n);
    expect(l.spent("0.0.10416991")).toBe(7n);
  });

  it("does not leak spend between assets", () => {
    // A token budget must not be consumed by HBAR payments.
    const l = new SpendLedger();
    l.record("0.0.0", "999999999");
    expect(l.spent("0.0.10416991")).toBe(0n);
  });

  it("reports zero for an asset never spent", () => {
    expect(new SpendLedger().spent("0.0.0")).toBe(0n);
  });

  it("summarises as strings, since these are exact integers", () => {
    const l = new SpendLedger();
    l.record("0.0.0", "9007199254740993"); // beyond Number.MAX_SAFE_INTEGER
    expect(l.summary()["0.0.0"]).toBe("9007199254740993");
  });
});
