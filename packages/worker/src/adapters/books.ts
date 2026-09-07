import type { Page } from "playwright";
import { decodeHtml, hasNextPage as sharedHasNextPage } from "../html.js";
import { BadParamsError, type JobContext, type Plan, type SiteAdapter } from "../types.js";

const ORIGIN = "https://books.toscrape.com";
/** Twenty products per category page. */
const PER_PAGE = 20;

export interface Category {
  slug: string;
  /** Books in the category, measured from the live site. Bounds the plan. */
  size: number;
}

/**
 * Category slugs are part of the URL and cannot be derived, so the catalogue is fixed
 * here. Keeping it explicit also bounds what a buyer can ask us to navigate to.
 *
 * Sizes are recorded because they determine how many pages exist, and quoting for pages
 * that cannot exist overcharges every job against a small category — travel is a single
 * page of eleven books, so a plan that assumes six pages is wrong by 5x.
 */
export const CATEGORIES: Record<string, Category> = {
  travel: { slug: "travel_2", size: 11 },
  mystery: { slug: "mystery_3", size: 32 },
  "historical-fiction": { slug: "historical-fiction_4", size: 26 },
  "sequential-art": { slug: "sequential-art_5", size: 75 },
  classics: { slug: "classics_6", size: 19 },
  philosophy: { slug: "philosophy_7", size: 11 },
  romance: { slug: "romance_8", size: 35 },
  fiction: { slug: "fiction_10", size: 65 },
  childrens: { slug: "childrens_11", size: 29 },
  poetry: { slug: "poetry_23", size: 19 },
  history: { slug: "history_32", size: 18 },
  horror: { slug: "horror_31", size: 17 },
  science: { slug: "science_22", size: 14 },
  music: { slug: "music_14", size: 13 },
  nonfiction: { slug: "nonfiction_13", size: 110 },
};

const RATING_WORDS: Record<string, number> = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };

export interface BooksParams {
  category: string;
  /** Only return books at or below this price, in pounds. */
  maxPrice: number;
  /** Only return books at or above this star rating. */
  minRating: number;
  max: number;
}

export interface Book {
  title: string;
  /** Pence, as an integer — the same reason prices are tinybars elsewhere. */
  pricePence: number;
  rating: number;
  inStock: boolean;
  url: string;
}

/**
 * Pure. Extracts products from one category page.
 *
 * Prices are parsed to integer pence rather than kept as floats: a filter like
 * "under £20" must not depend on whether 19.99 rounds up.
 */
export function parseBooks(html: string): Book[] {
  const out: Book[] = [];
  const blocks = html.split('<article class="product_pod">').slice(1);

  for (const block of blocks) {
    const ratingWord = /class="star-rating ([A-Za-z]+)"/.exec(block)?.[1];
    const anchor = /<h3><a href="([^"]*)" title="([^"]*)"/.exec(block);
    const priceRaw = /price_color">\s*£?([\d.]+)/.exec(block)?.[1];
    if (!anchor || !priceRaw) continue;

    out.push({
      title: decodeHtml(anchor[2] as string),
      pricePence: Math.round(Number.parseFloat(priceRaw) * 100),
      rating: RATING_WORDS[ratingWord ?? ""] ?? 0,
      inStock: /class="instock availability"/.test(block),
      url: new URL((anchor[1] as string).replace(/^(\.\.\/)+/, ""), `${ORIGIN}/catalogue/`).href,
    });
  }
  return out;
}

export const hasNextPage = sharedHasNextPage;


export const booksAdapter: SiteAdapter<BooksParams, Book> = {
  spec: {
    name: "books.filter_catalogue",
    site: ORIGIN,
    description:
      "Open a category, paginate the catalogue, and return in-stock books matching a price ceiling and minimum star rating.",
    priceBook: {
      base: "60000",
      perStep: "45000",
      perPage: "90000",
      perSecond: "9000",
      ceiling: "9000000",
    },
    limits: { maxSteps: 60, maxPages: 25, maxSessionMs: 180_000 },
  },

  normalise(params: unknown): BooksParams {
    const p = (params ?? {}) as Record<string, unknown>;
    const category = typeof p.category === "string" ? p.category.trim().toLowerCase() : "";
    if (!(category in CATEGORIES)) {
      throw new BadParamsError(
        `unknown \`category\` — one of: ${Object.keys(CATEGORIES).join(", ")}`,
      );
    }
    const maxPrice = p.maxPrice === undefined ? 1000 : Number(p.maxPrice);
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
      throw new BadParamsError("`maxPrice` must be a positive number of pounds");
    }
    const minRating = p.minRating === undefined ? 0 : Number(p.minRating);
    if (!Number.isInteger(minRating) || minRating < 0 || minRating > 5) {
      throw new BadParamsError("`minRating` must be an integer between 0 and 5");
    }
    const max = p.max === undefined ? 10 : Number(p.max);
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      throw new BadParamsError("`max` must be an integer between 1 and 100");
    }
    return { category, maxPrice, minRating, max };
  },

  /**
   * Filtering happens after extraction, so how far we must paginate depends on how
   * selective the filter is — which we cannot know without looking. The plan assumes a
   * hit rate from the rating filter, then clamps to the pages the category *actually*
   * has. A stricter filter than assumed costs the seller a page or two: cap and absorb.
   */
  plan(params: BooksParams): Plan {
    const category = CATEGORIES[params.category] as Category;
    const availablePages = Math.ceil(category.size / PER_PAGE);
    const selectivity = params.minRating >= 4 ? 0.25 : params.minRating >= 3 ? 0.5 : 1;

    const pages = Math.min(
      Math.max(1, Math.ceil(params.max / (PER_PAGE * selectivity))),
      availablePages,
      booksAdapter.spec.limits.maxPages,
    );
    const steps = pages;
    return {
      steps,
      pages,
      estimatedMs: 700 + steps * 500,
      outline: [
        `open category /${params.category}/ (${category.size} books, ${availablePages} page${availablePages > 1 ? "s" : ""})`,
        ...Array.from({ length: pages - 1 }, (_, i) => `paginate to page ${i + 2}`),
        `filter to <= £${params.maxPrice} and >= ${params.minRating} stars`,
        `return up to ${params.max}`,
      ],
    };
  },

  parse: parseBooks,

  async run(ctx: JobContext<Page>, params: BooksParams): Promise<Book[]> {
    const { page, meter } = ctx;
    const { slug } = CATEGORIES[params.category] as Category;
    const maxPence = Math.round(params.maxPrice * 100);

    const matched: Book[] = [];
    let pageNo = 1;

    while (matched.length < params.max) {
      const url =
        pageNo === 1
          ? `${ORIGIN}/catalogue/category/books/${slug}/index.html`
          : `${ORIGIN}/catalogue/category/books/${slug}/page-${pageNo}.html`;

      const html = await meter.step(`open ${url}`, async () => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return page.content();
      });

      meter.countPage(url);
      ctx.assertWithinLimits();

      const found = parseBooks(html);
      if (found.length === 0) break;

      matched.push(
        ...found.filter(
          (b) => b.inStock && b.pricePence <= maxPence && b.rating >= params.minRating,
        ),
      );

      if (!hasNextPage(html)) break;
      pageNo += 1;
    }

    return matched.slice(0, params.max);
  },
};
