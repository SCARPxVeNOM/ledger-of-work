import { describe, expect, it } from "vitest";
import { HCS_CHUNK_BYTES } from "@low/protocol";
import { buildFeedback, formatFeedback, type FeedbackEntry } from "../src/feedback.js";

describe("buildFeedback", () => {
  it("requires an attributable name", () => {
    expect(() => buildFeedback({ from: "" })).toThrow(/required/);
    expect(() => buildFeedback({ from: "   " })).toThrow(/required/);
  });

  it("keeps only the fields that were given", () => {
    const f = buildFeedback({ from: "ada", at: "2026-09-09T00:00:00.000Z" });
    expect(f).toEqual({ v: 1, kind: "feedback", from: "ada", at: "2026-09-09T00:00:00.000Z" });
    expect("didVerify" in f).toBe(false);
  });

  it("records false answers rather than dropping them", () => {
    // `priceWasLegible: false` is the most useful answer there is; a truthiness check
    // would have thrown it away.
    const f = buildFeedback({ from: "ada", priceWasLegible: false, didVerify: false });
    expect(f.priceWasLegible).toBe(false);
    expect(f.didVerify).toBe(false);
  });

  it("fits one HCS chunk even with long notes", () => {
    const f = buildFeedback({ from: "ada", notes: "x".repeat(5000), wanted: "y".repeat(5000) });
    expect(JSON.stringify(f).length).toBeLessThanOrEqual(HCS_CHUNK_BYTES);
  });

  it("rejects a name too long to be useful", () => {
    expect(() => buildFeedback({ from: "a".repeat(61) })).toThrow(/60/);
  });
});

describe("formatFeedback", () => {
  const entry = (over: Partial<FeedbackEntry> = {}): FeedbackEntry => ({
    feedback: buildFeedback({ from: "ada", capability: "virgo.catalogue_search" }),
    submitter: "0.0.777",
    sequenceNumber: 1,
    consensusTimestamp: "1788820764.094188030",
    selfReported: false,
    ...over,
  });

  it("says so plainly when there is nothing", () => {
    expect(formatFeedback([])).toBe("No feedback yet.");
  });

  it("marks entries the project posted itself", () => {
    // A reader deserves to know which criticism came from outside and which we typed in.
    // Without this the topic proves nothing about external testing.
    const out = formatFeedback([entry({ selfReported: true })]);
    expect(out).toContain("[self-reported]");
  });

  it("counts only genuinely external entries in the header", () => {
    const out = formatFeedback([entry(), entry({ selfReported: true, sequenceNumber: 2 })]);
    expect(out).toContain("2 entries, 1 from accounts the project does not control");
  });

  it("always shows the posting account, not just the claimed name", () => {
    expect(formatFeedback([entry()])).toContain("posted by 0.0.777");
  });

  it("does not hide unreadable entries", () => {
    expect(formatFeedback([entry({ feedback: null })])).toContain("unreadable");
  });
});
