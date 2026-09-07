import type { Page } from "playwright";
import { decodeHtml, hasNextPage as sharedHasNextPage } from "../html.js";
import { BadParamsError, type JobContext, type Plan, type SiteAdapter } from "../types.js";

const ORIGIN = "https://quotes.toscrape.com";
/** The site renders ten quotes per page; used to plan how far we have to paginate. */
const PER_PAGE = 10;

/**
 * Measured page depths on the live site. Filtering by tag caps out at two pages, while
 * the unfiltered listing runs to ten — which is where genuine variation in work lives.
 * Planning against the real ceiling stops us quoting for pages that cannot exist.
 */
const MAX_PAGES_TAGGED = 2;
const MAX_PAGES_ALL = 10;

export interface QuotesParams {
  /** Tag to filter by, e.g. "love". Omit to browse the full listing. */
  tag: string | null;
  /** How many quotes to return. */
  max: number;
  /**
   * Whether to log in first. The site accepts any credentials and gates nothing, but the
   * flow is a real form POST with a CSRF token and a session cookie — which is the point:
   * a plain GET cannot reproduce it.
   */
  login: boolean;
}

export interface Quote {
  text: string;
  author: string;
  tags: string[];
}

/** Pure. Extracts quotes from one page of markup so extraction is testable with no browser. */
export function parseQuotes(html: string): Quote[] {
  const out: Quote[] = [];
  const blocks = html.split('<div class="quote"').slice(1);
  for (const block of blocks) {
    const text = matchOne(block, /<span class="text"[^>]*>([\s\S]*?)<\/span>/);
    const author = matchOne(block, /<small class="author"[^>]*>([\s\S]*?)<\/small>/);
    if (text === null || author === null) continue;
    const tags = [...block.matchAll(/<a class="tag"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
      decodeHtml(m[1] as string),
    );
    out.push({ text: decodeHtml(text), author: decodeHtml(author), tags });
  }
  return out;
}

/** True when the page offers a "Next" link — i.e. more results exist. */
export const hasNextPage = sharedHasNextPage;

function matchOne(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m ? (m[1] as string) : null;
}


export const quotesAdapter: SiteAdapter<QuotesParams, Quote> = {
  spec: {
    name: "quotes.search_and_extract",
    site: ORIGIN,
    description:
      "Log in, filter quotes by tag, paginate through results, and extract quote text, author and tags.",
    priceBook: {
      base: "60000",
      perStep: "45000",
      perPage: "90000",
      perSecond: "9000",
      ceiling: "6000000",
    },
    limits: { maxSteps: 40, maxPages: 12, maxSessionMs: 120_000 },
  },

  normalise(params: unknown): QuotesParams {
    const p = (params ?? {}) as Record<string, unknown>;

    let tag: string | null = null;
    if (p.tag !== undefined && p.tag !== null && p.tag !== "") {
      if (typeof p.tag !== "string") throw new BadParamsError("`tag` must be a string");
      tag = p.tag.trim().toLowerCase();
      if (!/^[a-z-]{1,40}$/.test(tag)) {
        throw new BadParamsError("`tag` must be 1-40 lowercase letters or hyphens");
      }
    }

    const max = p.max === undefined ? 10 : Number(p.max);
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      throw new BadParamsError("`max` must be an integer between 1 and 100");
    }
    return { tag, max, login: p.login === undefined ? true : Boolean(p.login) };
  },

  /**
   * Pure, and bounded by what the site can actually serve.
   *
   * Quoting for pages that do not exist would overcharge on every filtered job, since a
   * tag never has more than two. Where the estimate is still wrong the seller absorbs
   * it: `exact` settlement gives no way to charge more after the fact.
   */
  plan(params: QuotesParams): Plan {
    const pageCeiling = params.tag ? MAX_PAGES_TAGGED : MAX_PAGES_ALL;
    const pages = Math.min(Math.ceil(params.max / PER_PAGE), pageCeiling);
    const loginSteps = params.login ? 2 : 0; // open form, submit it
    const steps = loginSteps + pages; // one navigation per result page
    const where = params.tag ? `/tag/${params.tag}/` : "/";
    const outline = [
      ...(params.login ? ["open login form", "submit credentials"] : []),
      `open ${where}`,
      ...Array.from({ length: pages - 1 }, (_, i) => `paginate to page ${i + 2}`),
      `extract up to ${params.max} quotes`,
    ];
    return { steps, pages, estimatedMs: 900 + steps * 550, outline };
  },

  parse: parseQuotes,

  async run(ctx: JobContext<Page>, params: QuotesParams): Promise<Quote[]> {
    const { page, meter } = ctx;

    if (params.login) {
      await meter.step("open login form", async () => {
        await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });
      });
      await meter.step("submit credentials", async () => {
        // The site accepts anything; the CSRF token in the form is what makes this a
        // real POST rather than a GET in disguise.
        await page.fill("input[name=username]", "agent");
        await page.fill("input[name=password]", "agent");
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          page.click("input[type=submit]"),
        ]);
      });
    }

    const collected: Quote[] = [];
    let pageNo = 1;

    while (collected.length < params.max) {
      const base = params.tag ? `${ORIGIN}/tag/${params.tag}` : ORIGIN;
      const url = pageNo === 1 ? `${base}/` : `${base}/page/${pageNo}/`;

      const html = await meter.step(`open ${url}`, async () => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return page.content();
      });

      meter.countPage(url);
      ctx.assertWithinLimits();

      const found = parseQuotes(html);
      if (found.length === 0) break; // tag has no (more) results
      collected.push(...found);

      if (!hasNextPage(html)) break;
      pageNo += 1;
    }

    return collected.slice(0, params.max);
  },
};
