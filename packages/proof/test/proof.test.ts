import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRetrievalProof, hashProof, summarise } from "../src/index.js";
import { checkCoverage, matchedValues, reviveBytes, witnessedRequest } from "../src/portable.js";
import type { RetrievalProof } from "../src/portable.js";

/**
 * A real proof, obtained from the public Reclaim attestor on 2026-09-09 for a live GET of
 * whitehouse.gov's Presidential Actions listing.
 *
 * Regenerate with `node scripts/spike-zktls-oracle.mjs`, which writes a fresh proof to
 * `.data/zktls-oracle-proof.json`; this file is a copy of one such run.
 *
 * A hand-built fixture would be worthless here. The thing under test is whether we can
 * tell a genuine attestor signature from a tampered one, and a fake proof cannot exercise
 * that — it would fail every check for the wrong reason and every test would pass.
 */
const PROOF = JSON.parse(
  readFileSync(new URL("./whitehouse-proof.json", import.meta.url), "utf8"),
) as RetrievalProof;

/** The delivered answer this proof was taken for. */
const ANSWER =
  "Patriot Day 2026, The 25th Anniversary of the September 11 Terrorist Attacks, and National Day of Service and Remembrance";

const clone = (): RetrievalProof => JSON.parse(JSON.stringify(PROOF)) as RetrievalProof;

describe("reading a proof", () => {
  it("reports the request that was witnessed", () => {
    expect(witnessedRequest(PROOF)).toEqual({
      url: "https://www.whitehouse.gov/presidential-actions/",
      method: "GET",
    });
  });

  it("reports what the attestor confirmed was in the response", () => {
    expect(matchedValues(PROOF)).toEqual(["Patriot Day 2026, The 25th Anniversary of the Se"]);
  });

  it("survives unparseable parameters rather than throwing", () => {
    const broken = clone();
    broken.claim.parameters = "not json";
    expect(witnessedRequest(broken)).toBeNull();
    expect(matchedValues(broken)).toEqual([]);
  });

  it("summarises into something small enough for a receipt", () => {
    const ref = summarise(PROOF);
    expect(ref.proofHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A pointer and nothing else. The attestor address and the matched text both live in
    // the proof, which a checker must hold anyway, and cost 56 and 61 bytes of a
    // 1024-byte receipt to restate.
    expect(Object.keys(ref)).toEqual(["proofHash"]);
    expect(JSON.stringify(ref).length).toBeLessThan(100);
  });

  it("hashes stably, so the receipt's commitment means something", () => {
    expect(hashProof(PROOF)).toBe(hashProof(clone()));
  });

  it("hashes differently when any byte of the proof changes", () => {
    const altered = clone();
    altered.claim.timestampS += 1;
    expect(hashProof(altered)).not.toBe(hashProof(PROOF));
  });
});

describe("reviveBytes", () => {
  it("turns index-keyed objects back into byte arrays", () => {
    const revived = reviveBytes({ sig: { 0: 1, 1: 2, 2: 255 } }) as unknown as { sig: Uint8Array };
    expect(revived.sig).toBeInstanceOf(Uint8Array);
    expect([...revived.sig]).toEqual([1, 2, 255]);
  });

  it("leaves ordinary objects alone", () => {
    expect(reviveBytes({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
    // A key that merely looks numeric among non-numeric ones is not a byte array.
    expect(reviveBytes({ 0: 1, name: "x" })).toEqual({ 0: 1, name: "x" });
  });

  it("finds every byte array in a real proof, not just the obvious one", () => {
    // Five of them, scattered across the claim and the request that produced it. Missing
    // any one makes signature verification fail while encoding rather than while
    // checking, which is what turns a tamper test into a test of nothing.
    const revived = reviveBytes(clone()) as unknown as Record<string, never>;
    let found = 0;
    const walk = (node: unknown): void => {
      if (node instanceof Uint8Array) {
        found++;
        return;
      }
      if (node && typeof node === "object") for (const v of Object.values(node)) walk(v);
    };
    walk(revived);
    expect(found).toBe(5);
  });
});

describe("checkCoverage — does the proof support the answer that was sold?", () => {
  const base = { proof: PROOF, expectedUrl: "https://www.whitehouse.gov/presidential-actions/" };

  it("accepts a proof whose witnessed text is in the answer", () => {
    const r = checkCoverage({ ...base, answer: ANSWER });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("whitehouse.gov");
  });

  it("rejects a proof of a different site", () => {
    const r = checkCoverage({ ...base, expectedUrl: "https://example.com/x", answer: ANSWER });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("example.com");
  });

  it("rejects a genuine proof stapled to an answer it does not support", () => {
    // The attack this check exists for: witness a real page, return something else.
    const r = checkCoverage({ ...base, answer: "The president has resigned" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not in the delivered answer");
  });

  it("rejects a proof that asserts nothing about the body", () => {
    const empty = clone();
    const params = JSON.parse(empty.claim.parameters);
    params.responseMatches = [];
    empty.claim.parameters = JSON.stringify(params);
    const r = checkCoverage({ ...base, proof: empty, answer: ANSWER });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("asserts nothing");
  });

  it("compares on collapsed whitespace, because one side is rendered text", () => {
    const spaced = ANSWER.replace(/ /g, "\n  ");
    expect(checkCoverage({ ...base, answer: spaced }).ok).toBe(true);
  });
});

/**
 * The signature checks. These are the reason any of this is worth more than the evidence
 * bundle, so they are tested by trying to break them — a check only ever seen to pass is
 * indistinguishable from a check that always passes.
 */
describe("checkRetrievalProof", () => {
  const ref = summarise(PROOF);
  const run = (proof: RetrievalProof, overrides: Partial<{ ref: typeof ref; answer: string }> = {}) =>
    checkRetrievalProof({
      proof,
      ref: overrides.ref ?? ref,
      expectedUrl: "https://www.whitehouse.gov/presidential-actions/",
      answer: overrides.answer ?? ANSWER,
    });

  const idOf = (checks: Awaited<ReturnType<typeof run>>, id: string) =>
    checks.find((c) => c.id === id);

  it("accepts the untouched proof on all three counts", async () => {
    const checks = await run(PROOF);
    expect(checks.map((c) => [c.id, c.ok])).toEqual([
      ["proof-hash", true],
      ["proof-signature", true],
      ["proof-coverage", true],
    ]);
  });

  it("rejects a flipped bit in the signature", async () => {
    const tampered = clone();
    const sig = tampered.signatures.claimSignature as Record<string, number>;
    sig["8"] = ((sig["8"] as number) ^ 1) & 0xff;
    expect(idOf(await run(tampered), "proof-signature")?.ok).toBe(false);
  });

  it("rejects a re-pointed URL", async () => {
    const tampered = clone();
    const params = JSON.parse(tampered.claim.parameters);
    params.url = "https://www.whitehouse.gov/briefing-room/";
    tampered.claim.parameters = JSON.stringify(params);
    expect(idOf(await run(tampered), "proof-signature")?.ok).toBe(false);
  });

  it("rejects a re-owned claim", async () => {
    const tampered = clone();
    tampered.claim.owner = "0x0000000000000000000000000000000000000001";
    expect(idOf(await run(tampered), "proof-signature")?.ok).toBe(false);
  });

  it("rejects a valid proof that the receipt did not commit to", async () => {
    // Swapping in a genuine proof of some other page after the fact. The signature is
    // real, so only the hash commitment catches this.
    const checks = await run(PROOF, { ref: { ...ref, proofHash: `sha256:${"0".repeat(64)}` } });
    expect(idOf(checks, "proof-hash")?.ok).toBe(false);
    expect(idOf(checks, "proof-signature")?.ok).toBe(true);
  });

  it("carries no credential — the proof is safe to hand over", async () => {
    const text = JSON.stringify(PROOF).toLowerCase();
    for (const secret of ["bearer", "authorization", "cookie"]) {
      expect(text.includes(secret), `${secret} leaked into the proof`).toBe(false);
    }
  });
}, 30_000);
