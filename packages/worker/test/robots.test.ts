import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots, rulesForStatus } from "../src/policy/robots.js";

/**
 * The robots.txt parser.
 *
 * This is the file that decides whether a site has agreed to be read, so getting it
 * subtly wrong means either refusing sites that welcomed us or crawling sites that asked
 * us not to. The second is the one that gets a service blocked and sued, and it is the
 * one a casual implementation gets wrong — almost always by mishandling a bare
 * `Disallow:`, which means the opposite of what it looks like.
 */

const UA = "LedgerOfWork";
const check = (body: string, path: string, ua = UA) => isAllowed(parseRobots(body, ua), path);

describe("a bare Disallow", () => {
  it("means no restrictions, not total refusal", () => {
    // whitehouse.gov serves exactly this. Reading it as "Disallow: /" would refuse one of
    // the three sources this product was built around.
    const body = "User-agent: *\nDisallow:";

    expect(check(body, "/presidential-actions/").allowed).toBe(true);
    expect(check(body, "/anything/at/all").allowed).toBe(true);
  });

  it("is not confused with a Disallow of the root", () => {
    const body = "User-agent: *\nDisallow: /";

    expect(check(body, "/").allowed).toBe(false);
    expect(check(body, "/anything").allowed).toBe(false);
  });
});

describe("longest match wins, not first match", () => {
  const body = ["User-agent: *", "Disallow: /docs", "Allow: /docs/public", ""].join("\n");

  it("refuses the broader path", () => {
    expect(check(body, "/docs/private").allowed).toBe(false);
  });

  it("permits the more specific one even though it comes second", () => {
    // A first-match parser refuses this, which would silently lose access to everything
    // a site deliberately opened up.
    expect(check(body, "/docs/public/report.html").allowed).toBe(true);
  });

  it("gives Allow the tie when the patterns are the same length", () => {
    const tie = "User-agent: *\nDisallow: /a\nAllow: /a";
    expect(check(tie, "/a").allowed).toBe(true);
  });
});

describe("wildcards and anchors", () => {
  it("treats * as any run of characters", () => {
    const body = "User-agent: *\nDisallow: /*/private";
    expect(check(body, "/team/private").allowed).toBe(false);
    expect(check(body, "/team/public").allowed).toBe(true);
  });

  it("anchors with a trailing $", () => {
    const body = "User-agent: *\nDisallow: /*.pdf$";
    expect(check(body, "/report.pdf").allowed).toBe(false);
    expect(check(body, "/report.pdf.html").allowed).toBe(true);
  });

  it("matches against the query string too", () => {
    const body = "User-agent: *\nDisallow: /*?sort=";
    expect(check(body, "/list?sort=price").allowed).toBe(false);
    expect(check(body, "/list?page=2").allowed).toBe(true);
  });

  it("does not let a dot in a pattern match any character", () => {
    // A pattern compiled without escaping would let /aXb match /a.b.
    const body = "User-agent: *\nDisallow: /a.b";
    expect(check(body, "/a.b").allowed).toBe(false);
    expect(check(body, "/aXb").allowed).toBe(true);
  });
});

describe("choosing the group that applies to us", () => {
  const body = [
    "User-agent: *",
    "Disallow: /",
    "",
    "User-agent: LedgerOfWork",
    "Disallow: /admin",
    "",
  ].join("\n");

  it("uses our own group and ignores the wildcard one entirely", () => {
    // Even though the wildcard group is stricter. The standard says one group applies.
    expect(check(body, "/public").allowed).toBe(true);
    expect(check(body, "/admin").allowed).toBe(false);
  });

  it("falls back to the wildcard group for an agent with no group of its own", () => {
    expect(check(body, "/public", "SomeOtherBot").allowed).toBe(false);
  });

  it("prefers the more specific of two matching names", () => {
    const two = [
      "User-agent: ledger",
      "Disallow: /",
      "",
      "User-agent: ledgerofwork",
      "Disallow: /admin",
    ].join("\n");
    expect(check(two, "/public").allowed).toBe(true);
  });

  it("reads several agents sharing one group", () => {
    const shared = ["User-agent: A", "User-agent: LedgerOfWork", "Disallow: /x"].join("\n");
    expect(check(shared, "/x").allowed).toBe(false);
    expect(check(shared, "/y").allowed).toBe(true);
  });

  it("starts a new group when rules are followed by another User-agent", () => {
    const body2 = [
      "User-agent: A",
      "Disallow: /",
      "User-agent: LedgerOfWork",
      "Disallow: /admin",
    ].join("\n");
    expect(check(body2, "/public").allowed).toBe(true);
  });
});

describe("the ragged edges of a real file", () => {
  it("ignores comments and blank lines", () => {
    const body = ["# a comment", "", "User-agent: *   # trailing", "Disallow: /x  # here too"].join("\n");
    expect(check(body, "/x").allowed).toBe(false);
  });

  it("reads field names case-insensitively", () => {
    expect(check("USER-AGENT: *\nDISALLOW: /x", "/x").allowed).toBe(false);
  });

  it("survives CRLF line endings", () => {
    expect(check("User-agent: *\r\nDisallow: /x\r\n", "/x").allowed).toBe(false);
  });

  it("allows everything when the file is empty", () => {
    expect(check("", "/anything").allowed).toBe(true);
  });

  it("picks up a crawl delay when one is stated", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 10", UA).crawlDelaySeconds).toBe(10);
  });

  it("names the rule that refused, so the buyer is told why", () => {
    const r = check("User-agent: *\nDisallow: /search", "/search?q=x");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.rule).toBe("Disallow: /search");
  });
});

describe("when robots.txt cannot be read", () => {
  it("treats a missing file as no restrictions", () => {
    expect(rulesForStatus(404)).toHaveProperty("rules");
  });

  it("refuses when the site forbids reading its rules", () => {
    // A 403 on robots.txt is a site with something to say that we could not hear.
    // Guessing "allowed" there is how a crawler ends up ignoring a refusal.
    expect(rulesForStatus(403)).toHaveProperty("refuse");
    expect(rulesForStatus(401)).toHaveProperty("refuse");
  });

  it("refuses when the site is broken rather than assuming consent", () => {
    expect(rulesForStatus(500)).toHaveProperty("refuse");
    expect(rulesForStatus(503)).toHaveProperty("refuse");
  });
});
