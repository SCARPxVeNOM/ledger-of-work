import { describe, expect, it } from "vitest";
import type { Receipt } from "@low/protocol";
import { formatUsage, summariseUsage } from "../src/usage.js";

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    v: 1,
    kind: "delivery",
    jobId: "j",
    capability: "quotes.search_and_extract",
    resultHash: "sha256:aa",
    sources: [],
    startedAt: "2026-09-08T04:12:03.114Z",
    finishedAt: "2026-09-08T04:12:09.882Z",
    plan: { steps: 3, pages: 1, estimatedMs: 3000 },
    work: { steps: 3, pages: 1, sessionMs: 5000 },
    price: { unit: "tinybar", quoted: "312000", charged: "312000" },
    payment: {
      network: "hedera:testnet",
      scheme: "exact",
      asset: "0.0.0",
      payer: "0.0.111",
      payTo: "0.0.999",
    },
    status: "ok",
    ...over,
  };
}

const at = (secs: number) => ({ consensusTimestamp: `${secs}.000000000` });

describe("summariseUsage", () => {
  it("counts jobs, successes and failures", () => {
    const r = summariseUsage("0.0.1", [
      { receipt: receipt(), ...at(1000) },
      { receipt: receipt(), ...at(1001) },
      { receipt: receipt({ status: "failed", price: { unit: "tinybar", quoted: "1", charged: "0" } }), ...at(1002) },
    ]);
    expect(r.jobs).toBe(3);
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(1);
  });

  it("counts a failed job as a job — excluding them would flatter the success rate", () => {
    const r = summariseUsage("0.0.1", [
      { receipt: receipt({ status: "failed", price: { unit: "tinybar", quoted: "1", charged: "0" } }), ...at(1) },
    ]);
    expect(r.jobs).toBe(1);
    expect(r.succeeded).toBe(0);
    expect(formatUsage(r)).toContain("0% success");
  });

  it("does not count a payer who was never charged", () => {
    // A failed job charges zero. Counting its payer would inflate the user number with
    // people who paid nothing, which is exactly the number a reader should distrust.
    const r = summariseUsage("0.0.1", [
      { receipt: receipt({ status: "failed", price: { unit: "tinybar", quoted: "1", charged: "0" }, payment: { ...receipt().payment, payer: "0.0.ghost" } }), ...at(1) },
    ]);
    expect(r.distinctPayers).toBe(0);
    expect(r.payers).toEqual([]);
  });

  it("counts each paying account once however many jobs it ran", () => {
    const r = summariseUsage("0.0.1", [
      { receipt: receipt(), ...at(1) },
      { receipt: receipt(), ...at(2) },
      { receipt: receipt({ payment: { ...receipt().payment, payer: "0.0.222" } }), ...at(3) },
    ]);
    expect(r.distinctPayers).toBe(2);
    expect(r.payers).toEqual(["0.0.111", "0.0.222"]);
  });

  it("totals revenue per denomination, keeping tokens separate from HBAR", () => {
    const r = summariseUsage("0.0.1", [
      { receipt: receipt(), ...at(1) },
      { receipt: receipt(), ...at(2) },
      { receipt: receipt({ price: { unit: "WORK", quoted: "312", charged: "312" } }), ...at(3) },
    ]);
    expect(r.revenue).toEqual({ tinybar: "624000", WORK: "312" });
  });

  it("sums revenue as integers, beyond what a float could hold", () => {
    const big = "9007199254740993";
    const r = summariseUsage("0.0.1", [
      { receipt: receipt({ price: { unit: "tinybar", quoted: big, charged: big } }), ...at(1) },
      { receipt: receipt({ price: { unit: "tinybar", quoted: big, charged: big } }), ...at(2) },
    ]);
    expect(r.revenue.tinybar).toBe("18014398509481986");
  });

  it("breaks jobs down by capability", () => {
    const r = summariseUsage("0.0.1", [
      { receipt: receipt(), ...at(1) },
      { receipt: receipt({ capability: "virgo.catalogue_search" }), ...at(2) },
      { receipt: receipt({ capability: "virgo.catalogue_search" }), ...at(3) },
    ]);
    expect(r.byCapability).toEqual({
      "quotes.search_and_extract": 1,
      "virgo.catalogue_search": 2,
    });
  });

  it("totals the work actually metered", () => {
    const r = summariseUsage("0.0.1", [
      { receipt: receipt(), ...at(1) },
      { receipt: receipt({ work: { steps: 12, pages: 10, sessionMs: 5000 } }), ...at(2) },
    ]);
    expect(r.work).toEqual({ steps: 15, pages: 11, sessionMs: 10000 });
  });

  it("reports the first and last job by consensus time, not by array order", () => {
    const r = summariseUsage("0.0.1", [
      { receipt: receipt(), ...at(3000) },
      { receipt: receipt(), ...at(1000) },
      { receipt: receipt(), ...at(2000) },
    ]);
    expect(r.firstAt).toBe(new Date(1_000_000).toISOString());
    expect(r.lastAt).toBe(new Date(3_000_000).toISOString());
  });

  it("reports unreadable messages rather than dropping them silently", () => {
    const r = summariseUsage("0.0.1", [
      { receipt: receipt(), ...at(1) },
      { receipt: null, ...at(2) },
    ]);
    expect(r.jobs).toBe(2);
    expect(r.unreadable).toBe(1);
    expect(r.succeeded).toBe(1);
    expect(formatUsage(r)).toContain("unreadable");
  });

  it("handles an empty topic without dividing by zero", () => {
    const r = summariseUsage("0.0.1", []);
    expect(r.jobs).toBe(0);
    expect(r.firstAt).toBeNull();
    expect(formatUsage(r)).toContain("0% success");
  });
});
