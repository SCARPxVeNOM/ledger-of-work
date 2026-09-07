import { describe, expect, it } from "vitest";
import {
  consensusTimestampToMillis,
  hbarToTinybar,
  parseConsensusTimestamp,
  tinybarToHbar,
  toRestTxId,
  toSdkTxId,
} from "../src/hedera.js";

describe("transaction id conversion", () => {
  // Verified against the live testnet mirror node: the dashed form returns 200, the
  // SDK's @-form returns 400.
  const sdk = "0.0.9014225@1788817813.625461259";
  const rest = "0.0.9014225-1788817813-625461259";

  it("converts SDK form to REST form without corrupting the account id", () => {
    expect(toRestTxId(sdk)).toBe(rest);
  });

  it("does not fall for the naive chained replace", () => {
    // `id.replace("@","-").replace(".","-")` yields "0-0.9014225-..." — the bug this
    // function exists to prevent.
    expect(toRestTxId(sdk)).not.toContain("0-0.");
    expect(toRestTxId(sdk).startsWith("0.0.9014225-")).toBe(true);
  });

  it("round-trips both ways and is idempotent", () => {
    expect(toSdkTxId(rest)).toBe(sdk);
    expect(toRestTxId(rest)).toBe(rest);
    expect(toSdkTxId(sdk)).toBe(sdk);
    expect(toSdkTxId(toRestTxId(sdk))).toBe(sdk);
  });

  it("rejects unrecognised shapes rather than guessing", () => {
    expect(() => toRestTxId("not-an-id")).toThrow();
    expect(() => toRestTxId("0.0.1@nope")).toThrow();
  });
});

describe("tinybar math", () => {
  it("converts HBAR strings exactly, without floating point", () => {
    expect(hbarToTinybar("1")).toBe(100_000_000n);
    expect(hbarToTinybar("0.001")).toBe(100_000n);
    expect(hbarToTinybar("0.00000001")).toBe(1n);
    // 0.1 + 0.2 in floats is 0.30000000000000004; here it must be exact.
    expect(hbarToTinybar("0.1") + hbarToTinybar("0.2")).toBe(hbarToTinybar("0.3"));
  });

  it("round-trips through display form", () => {
    for (const hbar of ["0", "1", "0.001", "12.34567891".slice(0, 11), "1000"]) {
      expect(tinybarToHbar(hbarToTinybar(hbar))).toBe(String(Number(hbar)));
    }
  });

  it("rejects more precision than a tinybar can hold", () => {
    expect(() => hbarToTinybar("0.000000001")).toThrow();
    expect(() => hbarToTinybar("1.5e3")).toThrow();
  });
});

describe("consensus timestamps", () => {
  it("keeps nanosecond precision that a float would discard", () => {
    const a = parseConsensusTimestamp("1759153365.567557838");
    const b = parseConsensusTimestamp("1759153365.567557839");
    expect(a.nanos).not.toBe(b.nanos);
    // Both collapse to the same float — which is exactly why we do not parse them as one.
    expect(Number.parseFloat("1759153365.567557838")).toBe(
      Number.parseFloat("1759153365.567557839"),
    );
  });

  it("pads short nanosecond fields", () => {
    expect(parseConsensusTimestamp("100.5").nanos).toBe(500_000_000n);
  });

  it("converts to epoch millis", () => {
    expect(consensusTimestampToMillis("1759153365.567557838")).toBe(1_759_153_365_567);
  });

  it("rejects malformed timestamps", () => {
    expect(() => parseConsensusTimestamp("1759153365")).toThrow();
  });
});
