import type { PriceBook } from "@low/protocol/portable";

/**
 * Published price books, as data.
 *
 * Separate from the adapters because a verifier needs the *prices* but not the machinery
 * that earns them. Importing the catalogue would drag Playwright into any bundle that
 * only wanted to check a receipt — a browser page pulling in a browser automation driver.
 *
 * These must stay identical to each adapter's `spec.priceBook`; a test asserts it, so a
 * change to one that misses the other fails rather than quietly making the meter check
 * verify against a price nobody was charged.
 */
export const PRICE_BOOKS: Record<string, PriceBook> = {
  "quotes.search_and_extract": {
    base: "60000",
    perStep: "45000",
    perPage: "90000",
    perSecond: "9000",
    ceiling: "6000000",
  },
  "books.filter_catalogue": {
    base: "60000",
    perStep: "45000",
    perPage: "90000",
    perSecond: "9000",
    ceiling: "9000000",
  },
  "govinfo.federal_register_issues": {
    base: "60000",
    perStep: "45000",
    perPage: "90000",
    perSecond: "9000",
    ceiling: "9000000",
  },
  "virgo.catalogue_search": {
    base: "60000",
    perStep: "45000",
    perPage: "90000",
    perSecond: "9000",
    ceiling: "9000000",
  },
};
