import { describe, expect, it } from "vitest";
import { decodeHtml } from "../src/html.js";

describe("decodeHtml", () => {
  it("resolves the named entities the toscrape sites actually emit", () => {
    expect(decodeHtml("&ldquo;quoted&rdquo;")).toBe('"quoted"');
    expect(decodeHtml("It&#39;s")).toBe("It's");
    expect(decodeHtml("Parks &amp; Sites")).toBe("Parks & Sites");
    expect(decodeHtml("Noah&rsquo;s Ark")).toBe("Noah's Ark");
  });

  it("resolves numeric and hex character references", () => {
    expect(decodeHtml("&#65;&#66;")).toBe("AB");
    expect(decodeHtml("&#x41;&#x42;")).toBe("AB");
  });

  it("decodes in a single pass, so escaped markup stays escaped", () => {
    // Chained .replace() calls decode their own output: &amp;lt; -> &lt; -> "<".
    // A single pass must stop at the first resolution.
    expect(decodeHtml("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  });

  it("strips tags", () => {
    expect(decodeHtml("<span>hello <b>there</b></span>")).toBe("hello there");
  });

  it("normalises smart quotes to ASCII so hashes survive typography changes", () => {
    expect(decodeHtml("“x”")).toBe('"x"');
    expect(decodeHtml("‘y’")).toBe("'y'");
  });

  it("collapses whitespace and trims", () => {
    expect(decodeHtml("  a\n\n  b  ")).toBe("a b");
  });

  it("leaves unknown entities alone rather than mangling them", () => {
    expect(decodeHtml("&notarealentity;")).toBe("&notarealentity;");
    expect(decodeHtml("&#999999999;")).toBe("&#999999999;");
  });

  it("is idempotent on already-plain text", () => {
    const plain = "It's Only the Himalayas";
    expect(decodeHtml(plain)).toBe(plain);
  });
});
