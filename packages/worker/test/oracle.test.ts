import { describe, expect, it } from "vitest";
import { ALLOWED_SOURCES, checkSource, oracleAdapter, tidyValues } from "../src/adapters/oracle.js";

/**
 * `checkSource` is the only thing preventing a paid endpoint from pointing a real browser
 * wherever a stranger says. It is exported precisely so it can be tested here rather than
 * only through a live browser run, where the interesting cases would never be exercised.
 */
describe("checkSource — the abuse boundary", () => {
  const ok = (u: string) => {
    const r = checkSource(u);
    expect(r, `expected ${u} to be allowed`).not.toHaveProperty("error");
    return r as { url: URL };
  };
  const rejected = (u: string) => {
    const r = checkSource(u);
    expect(r, `expected ${u} to be rejected`).toHaveProperty("error");
    return (r as { error: string }).error;
  };

  it("allows a document on a source whose robots.txt was read", () => {
    expect(ok("https://www.whitehouse.gov/presidential-actions/").url.hostname).toBe(
      "www.whitehouse.gov",
    );
  });

  it("refuses hosts that are not on the list, and says what is", () => {
    const err = rejected("https://example.com/anything");
    expect(err).toContain("not an allowed source");
    expect(err).toContain("www.whitehouse.gov");
  });

  it("refuses the private targets an open fetcher would otherwise reach", () => {
    // None of these are on the allowlist, which is the whole point: an allowlist blocks
    // SSRF by construction rather than by trying to enumerate what is private.
    for (const u of [
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/admin",
      "https://127.0.0.1:8787/quote",
      "https://10.0.0.5/internal",
      "https://metadata.google.internal/computeMetadata/v1/",
    ]) {
      expect(rejected(u)).toContain("not an allowed source");
    }
  });

  it("is not fooled by an allowed host in the wrong part of the URL", () => {
    // Userinfo and subdomain tricks: both parse to a hostname that is not the allowed one.
    rejected("https://www.whitehouse.gov@evil.example.com/x");
    rejected("https://www.whitehouse.gov.evil.example.com/x");
    rejected("https://evil.example.com/?q=https://www.whitehouse.gov/");
  });

  it("refuses anything but https", () => {
    expect(rejected("http://www.whitehouse.gov/presidential-actions/")).toContain("https");
    expect(rejected("file:///etc/passwd")).toContain("https");
    rejected("not a url at all");
  });

  it("honours the disallowed paths recorded for each source", () => {
    expect(rejected("https://www.federalregister.gov/documents/search?q=x")).toContain("robots.txt");
    expect(rejected("https://www.govinfo.gov/search/anything")).toContain("robots.txt");
    // A document page on the same host is fine — the rule is per-path, not per-host.
    ok("https://www.federalregister.gov/documents/2026/01/02/some-rule");
  });

  it("records why every source is on the list", () => {
    for (const s of ALLOWED_SOURCES) {
      expect(s.note.length, `${s.host} has no note`).toBeGreaterThan(20);
    }
  });
});

describe("tidyValues", () => {
  it("collapses whitespace and drops matches that carry no text", () => {
    expect(tidyValues(["  a\n\n  b  ", "   ", "\n", "c"], 10)).toEqual([
      { rank: 1, value: "a b" },
      { rank: 2, value: "c" },
    ]);
  });

  it("ranks in document order so 'the first one' is unambiguous", () => {
    expect(tidyValues(["x", "y", "z"], 10).map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  it("stops at max, counting only values it kept", () => {
    // Blank matches must not consume the buyer's quota — otherwise a decorative element
    // early in the page silently costs them a result they paid for.
    expect(tidyValues(["  ", "a", "  ", "b", "c"], 2)).toEqual([
      { rank: 1, value: "a" },
      { rank: 2, value: "b" },
    ]);
  });

  it("truncates a value rather than letting one match bloat the result", () => {
    const [only] = tidyValues(["x".repeat(5_000)], 1);
    expect(only!.value.length).toBe(400);
  });
});

describe("oracle parameter validation", () => {
  const base = { url: "https://www.whitehouse.gov/presidential-actions/", select: "h2" };

  it("requires a source and an extraction rule", () => {
    expect(() => oracleAdapter.normalise({ select: "h2" })).toThrow(/url/);
    expect(() => oracleAdapter.normalise({ url: base.url })).toThrow(/select/);
    expect(() => oracleAdapter.normalise({ ...base, select: "   " })).toThrow(/select/);
  });

  it("surfaces the source rejection as a parameter error", () => {
    expect(() => oracleAdapter.normalise({ ...base, url: "https://example.com/" })).toThrow(
      /not an allowed source/,
    );
  });

  it("rejects an attribute that is not an attribute name", () => {
    // This string is read back out of the DOM, so it must not be an arbitrary expression.
    expect(() => oracleAdapter.normalise({ ...base, attribute: "href\"]);alert(1)//" })).toThrow(
      /attribute/,
    );
    expect(oracleAdapter.normalise({ ...base, attribute: "datetime" }).attribute).toBe("datetime");
  });

  it("treats absent optional selectors as absent rather than empty strings", () => {
    const p = oracleAdapter.normalise({ ...base, click: "", waitFor: null });
    expect(p.click).toBeNull();
    expect(p.waitFor).toBeNull();
  });

  it("bounds how many matches can be asked for", () => {
    expect(() => oracleAdapter.normalise({ ...base, max: 0 })).toThrow(/max/);
    expect(() => oracleAdapter.normalise({ ...base, max: 51 })).toThrow(/max/);
    expect(oracleAdapter.normalise(base).max).toBe(1);
  });

  it("outlines the capture so a buyer knows what they are paying for", () => {
    const outline = oracleAdapter.plan(oracleAdapter.normalise(base)).outline.join(" | ");
    expect(outline).toContain("www.whitehouse.gov");
    expect(outline).toContain("h2");
    expect(outline).toContain("screenshot");
  });
});
