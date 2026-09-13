import { describe, expect, it } from "vitest";
import { EXAMPLE_SOURCES, oracleAdapter, tidyValues } from "../src/adapters/oracle.js";
import { checkShape } from "../src/policy/source.js";

/**
 * What the adapter refuses without asking anyone.
 *
 * This used to be an allowlist, and an allowlist blocked server-side request forgery for
 * free — an intranet host simply was not on it. The allowlist is gone, so the refusals
 * split in two and both halves need testing:
 *
 *   - here, the ones knowable from the URL alone: scheme, credentials, literal addresses
 *   - in `source-policy.test.ts`, the ones needing a lookup: where a name resolves, what
 *     the site's robots.txt says
 *
 * The second half is where `localhost` and `metadata.google.internal` are now caught —
 * they are hostnames, so nothing about the string itself says they are private, and only
 * resolving them can tell.
 */
describe("refusals that need no lookup", () => {
  const ok = (u: string) => expect(checkShape(u), u).toMatchObject({ ok: true });
  const no = (u: string) => {
    const r = checkShape(u);
    expect(r, `expected ${u} to be refused`).toMatchObject({ ok: false });
    return (r as { ok: false; error: string }).error;
  };

  it("allows an ordinary public document", () => {
    ok("https://www.whitehouse.gov/presidential-actions/");
    // And now also a site nobody put on a list, which is the point of the change.
    ok("https://example.com/some/page");
  });

  it("refuses anything but https", () => {
    expect(no("http://www.whitehouse.gov/presidential-actions/")).toContain("https");
    expect(no("file:///etc/passwd")).toContain("https");
    no("not a url at all");
  });

  it("refuses a literal private address outright", () => {
    no("https://169.254.169.254/latest/meta-data/");
    no("https://127.0.0.1:8787/quote");
    no("https://10.0.0.5/internal");
    no("https://[::1]/admin");
  });

  it("refuses credentials in the URL, which confuse a host check", () => {
    // `https://www.whitehouse.gov@evil.example/x` has hostname evil.example. Refusing
    // userinfo outright is simpler than hoping every reader parses it correctly.
    no("https://www.whitehouse.gov@evil.example/x");
  });

  it("reads the hostname, not the parts of the URL that merely look like one", () => {
    // These are now *allowed* by shape — they are ordinary public hosts — and that is
    // correct. Whether they may be read is decided by their own robots.txt, not by
    // whether their name resembles someone else's.
    ok("https://www.whitehouse.gov.evil.example/x");
    ok("https://evil.example/?q=https://www.whitehouse.gov/");
  });

  it("says why each example source is worth naming", () => {
    for (const s of EXAMPLE_SOURCES) {
      expect(s.note.length, `${s.host} has no note`).toBeGreaterThan(20);
    }
  });

  it("advertises that permission is decided by the site, not by us", () => {
    // The manifest is what a buying agent reads before paying. It used to list three
    // allowed hosts; saying that now would be false.
    expect(oracleAdapter.spec.description).toContain("robots.txt");
    expect(oracleAdapter.spec.description).not.toContain("Allowed sources");
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

  it("accepts a source nobody put on a list", () => {
    // The change in one assertion: this used to throw "not an allowed source". Whether
    // example.com may actually be read is now decided by example.com, at quote time.
    expect(() => oracleAdapter.normalise({ ...base, url: "https://example.com/" })).not.toThrow();
  });

  it("still refuses a source that needs no lookup to reject", () => {
    expect(() => oracleAdapter.normalise({ ...base, url: "https://169.254.169.254/" })).toThrow(
      /link-local/,
    );
    expect(() => oracleAdapter.normalise({ ...base, url: "http://example.com/" })).toThrow(/https/);
  });

  it("has a precheck, because some refusals need the network", () => {
    // The quote path calls this; without it a buyer would be refused after signing.
    expect(typeof oracleAdapter.precheck).toBe("function");
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

describe("a capture that found nothing", () => {
  /**
   * The bug this closes, found by buying one.
   *
   * A Cloudflare-protected page served a bot challenge. The browser loaded it happily,
   * the selector matched nothing, and the job settled at full price with a receipt saying
   * `status: "ok"` and zero items. The receipt was honest — it faithfully recorded that
   * nothing had been delivered — and the buyer had paid 321,000 tinybar for it.
   */
  const params = oracleAdapter.normalise({
    url: "https://www.whitehouse.gov/presidential-actions/",
    select: ".wp-block-post-title",
    max: 3,
  });

  it("is not a delivery, so it is not charged for", () => {
    const verdict = oracleAdapter.delivered!([], params);

    expect(verdict.ok).toBe(false);
  });

  it("says what might have gone wrong, and that nothing was charged", () => {
    const verdict = oracleAdapter.delivered!([], params);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // The buyer cannot see our browser, so the message has to carry the possibilities.
    expect(verdict.why).toContain(".wp-block-post-title");
    expect(verdict.why).toMatch(/bot challenge|error page/);
    expect(verdict.why).toContain("Nothing was charged");
  });

  it("is a delivery the moment anything was captured", () => {
    expect(oracleAdapter.delivered!([{ rank: 1, value: "something" }], params).ok).toBe(true);
  });
});

describe("what the other capabilities do with an empty result", () => {
  it("leaves searching alone, because finding nothing is an answer", async () => {
    // "No quotes are tagged xyzzy" is information a buyer may legitimately pay for.
    // Refusing to charge for it would make revenue depend on the world, not the work —
    // and would let a buyer get free work by choosing a query with no matches.
    const { CATALOGUE } = await import("../src/index.js");
    for (const name of [
      "quotes.search_and_extract",
      "virgo.catalogue_search",
      "govinfo.federal_register_issues",
    ]) {
      expect(CATALOGUE[name]!.delivered, `${name} should not override delivered`).toBeUndefined();
    }
  });

  it("only the capture capability declares one", async () => {
    const { CATALOGUE } = await import("../src/index.js");
    const overriding = Object.entries(CATALOGUE)
      .filter(([, a]) => a.delivered)
      .map(([n]) => n);

    expect(overriding).toEqual(["oracle.capture_claim"]);
  });
});
