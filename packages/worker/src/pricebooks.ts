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
export const CURRENT_PRICE_BOOKS: Record<string, PriceBook> = {
  "quotes.search_and_extract": {
    base: "60000",
    perStep: "45000",
    perPage: "90000",
    perSecond: "9000",
    ceiling: "6000000",
  },
  "oracle.capture_claim": {
    base: "60000",
    perStep: "45000",
    perPage: "90000",
    perSecond: "9000",
    ceiling: "6000000",
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

/**
 * Capabilities that are no longer for sale, at the prices they were sold at.
 *
 * A receipt on the ledger is permanent, so the price it was charged under has to remain
 * checkable forever. Deleting a retired capability's price book would not invalidate
 * those receipts — it would do something worse, and quietly turn a meter check that used
 * to prove the charge into one that cannot be run. Retiring a capability removes it from
 * what can be bought, never from what can be verified.
 */
export const RETIRED_PRICE_BOOKS: Record<string, PriceBook> = {
  // Sold until 2026-09-10; receipts for it exist on topic 0.0.10413059. Retired because
  // a demo bookshop is not a source anyone needs a receipt about — replaced by
  // `oracle.capture_claim`, which reads primary sources.
  "books.filter_catalogue": {
    base: "60000",
    perStep: "45000",
    perPage: "90000",
    perSecond: "9000",
    ceiling: "9000000",
  },
};

/**
 * Every price book ever published. This is what a verifier should use: it is asked about
 * a receipt that already exists, which may name a capability that is no longer sold.
 */
export const PRICE_BOOKS: Record<string, PriceBook> = {
  ...CURRENT_PRICE_BOOKS,
  ...RETIRED_PRICE_BOOKS,
};
