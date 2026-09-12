import { describe, expect, it } from "vitest";
import { prefersHtml } from "../src/server.js";
import { renderLanding } from "../src/landing.js";

/**
 * `/` is the service manifest and its audience is software. It is now also readable by a
 * person, through content negotiation rather than a second URL — so the property that
 * actually matters is the negative one: every client that got JSON yesterday still gets
 * JSON. A seller that starts answering agents in HTML has broken discovery for everyone.
 */
describe("prefersHtml", () => {
  it("says yes to what a browser address bar sends", () => {
    // Chrome, verbatim.
    expect(
      prefersHtml("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8"),
    ).toBe(true);
    expect(prefersHtml("text/html")).toBe(true);
  });

  it("says no to every shape of programmatic client", () => {
    expect(prefersHtml(undefined)).toBe(false); // fetch with no headers
    expect(prefersHtml("*/*")).toBe(false); // curl
    expect(prefersHtml("application/json")).toBe(false); // an agent
    expect(prefersHtml("application/json, text/plain, */*")).toBe(false); // axios
  });

  it("respects the order when a client will take either", () => {
    // The distinction is which is asked for first, not whether html is mentioned at all.
    expect(prefersHtml("application/json, text/html")).toBe(false);
    expect(prefersHtml("text/html, application/json")).toBe(true);
  });

  it("ignores parameters, which is where the string gets ragged", () => {
    expect(prefersHtml("text/html; charset=utf-8")).toBe(true);
    expect(prefersHtml(" TEXT/HTML ,application/json")).toBe(true);
  });

  it("treats a +json suffix as json, since that is what it is", () => {
    expect(prefersHtml("application/ld+json, text/html")).toBe(false);
  });
});

describe("the landing page", () => {
  const input = {
    name: "Ledger of Work",
    description: "Pay-per-job access to websites that cannot be turned into an API.",
    uaid: "uaid:aid:abc;uid=0;registry=ledger-of-work;proto=a2a;nativeId=hedera:testnet:0.0.1",
    account: "0.0.10410493",
    network: "hedera:testnet",
    topicId: "0.0.10413059",
    facilitator: "https://api.testnet.blocky402.com",
    baseUrl: "https://seller.example",
    capabilities: [
      {
        name: "quotes.search_and_extract",
        description: "Search a catalogue and extract the matching records.",
        site: "quotes.toscrape.com",
        fromTinybar: "312000",
        ceilingTinybar: "6000000",
      },
    ],
  };

  it("states the things a reader came to check", () => {
    const html = renderLanding(input);

    expect(html).toContain("quotes.search_and_extract");
    expect(html).toContain("0.0.10413059");
    expect(html).toContain(input.uaid);
    expect(html).toMatch(/<!doctype html>/i);
  });

  it("states the rate card once when every capability shares it", () => {
    // Four identical "from" prices in a column read as a comparison and offer none. The
    // ceiling is the only thing that actually differs between these books.
    const html = renderLanding({
      ...input,
      sharedRates: { base: "60000", perStep: "45000", perPage: "90000", perSecond: "9000" },
    });

    expect(html).toContain("What you are charged");
    expect(html).toContain("max 0.06 ℏ"); // the ceiling, per row
    expect(html).not.toContain("from 0.00312 ℏ");
  });

  it("goes back to per-row prices the moment the books diverge", () => {
    expect(renderLanding(input)).toContain("from 0.00312 ℏ");
    expect(renderLanding(input)).not.toContain("What you are charged");
  });

  it("shows prices in HBAR, exactly, not in tinybars", () => {
    // 312000 tinybar is 0.00312 ℏ. Publishing the raw integer to a person invites an
    // eight-decimal-place mistake in the reader's head — and rounding it publishes a
    // number the seller is not charging, which is worse.
    expect(renderLanding(input)).toContain("0.00312 ℏ");
    expect(renderLanding(input)).not.toContain("0.0031 ℏ");
  });

  it("does not lose the small digits of a price, at either end", () => {
    const at = (fromTinybar: string) =>
      renderLanding({ ...input, capabilities: [{ ...input.capabilities[0]!, fromTinybar }] });

    expect(at("1")).toContain("0.00000001 ℏ"); // one tinybar, the smallest there is
    expect(at("100000000")).toContain("1 ℏ"); // exactly one, with no stray decimals
    expect(at("250000000")).toContain("2.5 ℏ");
  });

  it("escapes what it prints, because a manifest is data", () => {
    const html = renderLanding({
      ...input,
      capabilities: [{ ...input.capabilities[0]!, description: '<script>alert(1)</script>' }],
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
