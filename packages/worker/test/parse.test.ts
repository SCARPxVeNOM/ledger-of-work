import { describe, expect, it } from "vitest";
import { hasNextPage as quotesHasNext, parseQuotes } from "../src/adapters/quotes.js";

// Markup shapes copied from the live sites, trimmed to what the parsers read.
const QUOTES_HTML = `
<div class="quote" itemscope>
  <span class="text" itemprop="text">&ldquo;It is our choices, Harry.&rdquo;</span>
  <span>by <small class="author" itemprop="author">J.K. Rowling</small></span>
  <div class="tags"><a class="tag" href="/tag/abilities/page/1/">abilities</a><a class="tag" href="/tag/choices/page/1/">choices</a></div>
</div>
<div class="quote" itemscope>
  <span class="text" itemprop="text">&ldquo;It&#39;s not what we say &amp; do.&rdquo;</span>
  <span>by <small class="author" itemprop="author">Marilyn Monroe</small></span>
  <div class="tags"><a class="tag" href="/tag/love/page/1/">love</a></div>
</div>
<li class="next"><a href="/tag/love/page/2/">Next</a></li>`;


describe("parseQuotes", () => {
  const quotes = parseQuotes(QUOTES_HTML);

  it("extracts every quote on the page", () => {
    expect(quotes).toHaveLength(2);
  });

  it("decodes entities and smart quotes into plain text", () => {
    expect(quotes[0]!.text).toBe('"It is our choices, Harry."');
    expect(quotes[1]!.text).toBe(`"It's not what we say & do."`);
  });

  it("extracts author and tags", () => {
    expect(quotes[0]!.author).toBe("J.K. Rowling");
    expect(quotes[0]!.tags).toEqual(["abilities", "choices"]);
    expect(quotes[1]!.tags).toEqual(["love"]);
  });

  it("returns nothing rather than throwing on an empty or unexpected page", () => {
    expect(parseQuotes("")).toEqual([]);
    expect(parseQuotes("<html><body>no quotes here</body></html>")).toEqual([]);
  });

  it("skips malformed blocks instead of emitting half a quote", () => {
    const broken = '<div class="quote"><span class="text">orphaned</span></div>';
    expect(parseQuotes(broken)).toEqual([]);
  });

  it("detects pagination", () => {
    expect(quotesHasNext(QUOTES_HTML)).toBe(true);
    expect(quotesHasNext('<div class="quote"></div>')).toBe(false);
  });
});
