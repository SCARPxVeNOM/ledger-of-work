import { describe, expect, it } from "vitest";
import { assertValidUnits } from "../src/units.js";
import { readEvidence } from "../src/evidence.js";

/**
 * `finalUrl` used to live inside `evidence`, next to two hashes.
 *
 * It is a URL, not a commitment to a file — so a schema describing evidence as named
 * artifact hashes cannot hold it, and typing it that way would have rejected receipts
 * already on the topic. Sequence 55 carries exactly that shape.
 *
 * From v4 it is a field of its own. This reader hides the difference, which is the only
 * reason nothing downstream needs a version branch for it.
 */
describe("reading evidence off a receipt", () => {
  it("takes the hashes and leaves finalUrl alone on a v3 receipt", () => {
    const v3 = {
      evidence: {
        pageHash: "sha256:aa",
        screenshotHash: "sha256:bb",
        finalUrl: "https://www.whitehouse.gov/presidential-actions/",
      },
    };

    expect(readEvidence(v3)).toEqual({
      artifacts: { pageHash: "sha256:aa", screenshotHash: "sha256:bb" },
      finalUrl: "https://www.whitehouse.gov/presidential-actions/",
    });
  });

  it("reads a v2 receipt, which also carries capturedAt in there", () => {
    const v2 = {
      evidence: {
        pageHash: "sha256:aa",
        screenshotHash: "sha256:bb",
        finalUrl: "https://example.com/x",
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    // capturedAt is not a hash either, and must not be offered as an artifact to compare.
    expect(readEvidence(v2).artifacts).toEqual({
      pageHash: "sha256:aa",
      screenshotHash: "sha256:bb",
    });
  });

  it("reads a v4 receipt where finalUrl is its own field", () => {
    const v4 = { evidence: { output: "sha256:cc" }, finalUrl: "https://example.com/x" };

    expect(readEvidence(v4)).toEqual({
      artifacts: { output: "sha256:cc" },
      finalUrl: "https://example.com/x",
    });
  });

  it("reports no evidence as no artifacts rather than as an error", () => {
    expect(readEvidence({})).toEqual({ artifacts: {}, finalUrl: undefined });
  });

  it("accepts up to four named artifacts", () => {
    expect(() =>
      assertValidUnits(
        { output: "sha256:a", logs: "sha256:b", model: "sha256:c", input: "sha256:d" },
        "artifact",
      ),
    ).not.toThrow();
  });
});
