import { describe, expect, it } from "vitest";
import { hasNextPage as quotesHasNext, parseQuotes } from "../src/adapters/quotes.js";
import { parseBooks, hasNextPage as booksHasNext } from "../src/adapters/books.js";

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

const BOOKS_HTML = `
<article class="product_pod">
  <p class="star-rating Two"></p>
  <h3><a href="../../../its-only-the-himalayas_981/index.html" title="It&#39;s Only the Himalayas">It's Only ...</a></h3>
  <div class="product_price"><p class="price_color">£45.17</p>
  <p class="instock availability" class="instock availability"><i class="icon-ok"></i> In stock</p></div>
</article>
<article class="product_pod">
  <p class="star-rating Five"></p>
  <h3><a href="../../../see-america_732/index.html" title="See America: Parks &amp; Sites">See America</a></h3>
  <div class="product_price"><p class="price_color">£8.99</p>
  <p class="instock availability" class="instock availability"><i class="icon-ok"></i> In stock</p></div>
</article>`;

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

describe("parseBooks", () => {
  const books = parseBooks(BOOKS_HTML);

  it("extracts every product on the page", () => {
    expect(books).toHaveLength(2);
  });

  it("parses prices to integer pence, so filters do not depend on float rounding", () => {
    expect(books[0]!.pricePence).toBe(4517);
    expect(books[1]!.pricePence).toBe(899);
    expect(Number.isInteger(books[0]!.pricePence)).toBe(true);
  });

  it("maps star-rating words to numbers", () => {
    expect(books[0]!.rating).toBe(2);
    expect(books[1]!.rating).toBe(5);
  });

  it("decodes entities in titles", () => {
    expect(books[0]!.title).toBe("It's Only the Himalayas");
    expect(books[1]!.title).toBe("See America: Parks & Sites");
  });

  it("resolves relative product links to absolute URLs", () => {
    expect(books[0]!.url).toBe(
      "https://books.toscrape.com/catalogue/its-only-the-himalayas_981/index.html",
    );
  });

  it("reads stock state", () => {
    expect(books.every((b) => b.inStock)).toBe(true);
    expect(parseBooks(BOOKS_HTML.replace(/instock availability/g, "outofstock"))[0]!.inStock).toBe(
      false,
    );
  });

  it("returns nothing rather than throwing on an unexpected page", () => {
    expect(parseBooks("<html>nope</html>")).toEqual([]);
  });

  it("detects pagination", () => {
    expect(booksHasNext('<li class="next"><a href="page-2.html">next</a></li>')).toBe(true);
    expect(booksHasNext(BOOKS_HTML)).toBe(false);
  });
});
