import type { Page } from "playwright";
import { decodeHtml } from "../html.js";
import { BadParamsError, type JobContext, type Plan, type SiteAdapter } from "../types.js";

const ORIGIN = "https://search.lib.virginia.edu";

/**
 * Virgo, the University of Virginia Library catalogue.
 *
 * ── Why this site ───────────────────────────────────────────────────────────────
 * It is the only site in `scripts/survey-sites.mjs` that satisfies the whole pitch on
 * its own, which is the reason it is here rather than a more famous one:
 *
 *   not fetchable   a plain GET of a search URL returns a ~2.2KB application shell
 *   no API          nothing at /catalog.json, /api/search, ?format=json, /opensearch.xml
 *                   — every path answers with the same SPA shell
 *   crawlable       the site serves no robots.txt at all, so nothing is disallowed
 *
 * govinfo demonstrates "not a fetch" but publishes an official API, so it cannot carry
 * the "no API" half. Virgo carries both.
 *
 * Results paginate by a "Load More Results" button rather than by URL, so reaching the
 * fortieth result genuinely requires clicking — there is no page-2 address to fetch.
 *
 * ── Manners ─────────────────────────────────────────────────────────────────────
 * This is a working university library, not a sandbox. The step ceiling is deliberately
 * low, clicks are paced, `max` is capped well below what the catalogue holds, and the
 * user agent says who we are. No authentication is used or needed; this is the public
 * catalogue.
 */

/** Politeness pause between interactions with a real institution's service. */
const CLICK_DELAY_MS = 700;
/** Virgo renders twenty hits per batch. */
const PER_BATCH = 20;

export interface VirgoParams {
  /** Free-text catalogue query. */
  query: string;
  /** How many records to return. Capped low on purpose. */
  max: number;
}

export interface CatalogueRecord {
  /** Virgo's own item id, e.g. "u1931468". */
  id: string;
  title: string;
  author: string | null;
  format: string | null;
  /** Four-digit year when the record carries one. */
  year: number | null;
  library: string | null;
  callNumber: string | null;
  url: string;
}

/**
 * The labels Virgo actually renders.
 *
 * Explicit rather than a generic "Capitalised word before a colon" pattern, because that
 * pattern reads "Association Format:" as a label and truncates the author to "Freshwater
 * Biological". Knowing the real label set is what makes the boundaries right.
 */
const LABELS = [
  "Format",
  "Publication Date",
  "Availability",
  "Library",
  "Location",
  "Call Number",
  "Subject",
  "Author",
  // Found by running it: online records append this after the call number, and without
  // it here the call number captured "QC903 Access Online: Library Catalog (Click to
  // View)". Any label missing from this list silently lengthens the field before it.
  "Access Online",
  "Published",
  "Edition",
  "Series",
] as const;

/**
 * Pure. Reads the labelled fields out of one hit's rendered text.
 *
 * Deliberately parses the *text* rather than the DOM classes. Virgo is a Vue app whose
 * scoped-style attributes (`data-v-18db6a75`) change on every deploy, so a selector-based
 * parser would break silently on a Tuesday. The visible labels are content, and change
 * far less often.
 */
export function parseHitText(id: string, title: string, text: string): CatalogueRecord {
  const flat = decodeHtml(text);
  const boundary = LABELS.map((l) => l.replace(/ /g, "\\s+")).join("|");

  const field = (label: string): string | null => {
    // Capture up to the next known label, or the end.
    const re = new RegExp(`${label.replace(/ /g, "\\s+")}:\\s*(.+?)(?=\\s+(?:${boundary}):|$)`);
    const m = re.exec(flat);
    const value = m?.[1]?.trim();
    return value ? value : null;
  };

  const rawYear = field("Publication Date");
  // `\b` fails inside "c2003" because c and 2 are both word characters, which made a
  // date of "c2003, printed 2005" report 2005. Guard on digits instead.
  const yearMatch = rawYear ? /(?<!\d)(1\d{3}|20\d{2})(?!\d)/.exec(rawYear) : null;

  // The author sits between the title and the first labelled field, with the "Cite"
  // button's label landing in the text between them.
  let author: string | null = null;
  const afterTitle = flat.indexOf(title);
  if (afterTitle >= 0) {
    const tail = flat.slice(afterTitle + title.length);
    const upToFirstLabel = tail.split(new RegExp(`\\s+(?:${boundary}):`))[0] ?? "";
    author = upToFirstLabel.replace(/^\s*Cite\s*/i, "").trim() || null;
  }

  return {
    id,
    title: decodeHtml(title),
    author,
    format: field("Format"),
    year: yearMatch ? Number(yearMatch[1]) : null,
    library: field("Library"),
    callNumber: field("Call Number"),
    url: `${ORIGIN}/sources/uva_library/items/${id}`,
  };
}

export const virgoAdapter: SiteAdapter<VirgoParams, CatalogueRecord> = {
  spec: {
    name: "virgo.catalogue_search",
    site: ORIGIN,
    description:
      "Search the University of Virginia Library catalogue and return matching records with format, year, library and call number. Results load by button rather than by URL, and the site serves no API — a fetch returns an empty application shell.",
    priceBook: {
      base: "60000",
      perStep: "45000",
      perPage: "90000",
      perSecond: "9000",
      ceiling: "9000000",
    },
    // Low ceilings: this is a working library, and the flow should never run away on it.
    limits: { maxSteps: 8, maxPages: 5, maxSessionMs: 180_000 },
  },

  normalise(params: unknown): VirgoParams {
    const p = (params ?? {}) as Record<string, unknown>;

    const query = typeof p.query === "string" ? p.query.trim() : "";
    if (query.length < 2 || query.length > 120) {
      throw new BadParamsError("`query` must be between 2 and 120 characters");
    }
    // Keep the query to things that read as a search rather than an injection attempt.
    if (/[<>{}\\]/.test(query)) {
      throw new BadParamsError("`query` may not contain < > { } or backslashes");
    }

    const max = p.max === undefined ? 20 : Number(p.max);
    if (!Number.isInteger(max) || max < 1 || max > 60) {
      throw new BadParamsError("`max` must be an integer between 1 and 60");
    }

    return { query, max };
  },

  /** Pure. One navigation, then one click per further batch of twenty. */
  plan(params: VirgoParams): Plan {
    const batches = Math.ceil(params.max / PER_BATCH);
    const clicks = Math.max(0, batches - 1);
    const steps = 1 + clicks;
    return {
      steps,
      pages: batches,
      estimatedMs: 9_000 + clicks * 3_000,
      outline: [
        `search the catalogue for "${params.query}"`,
        ...Array.from({ length: clicks }, (_, i) => `load results ${(i + 1) * PER_BATCH + 1}-${(i + 2) * PER_BATCH}`),
        `extract up to ${params.max} records`,
      ],
    };
  },

  /** Not used: records are read from the live DOM, then parsed by `parseHitText`. */
  parse(): CatalogueRecord[] {
    return [];
  },

  async run(ctx: JobContext<Page>, params: VirgoParams): Promise<CatalogueRecord[]> {
    const { page, meter } = ctx;
    const url = `${ORIGIN}/search?q=${encodeURIComponent(`keyword: ${params.query}`)}&pool=uva_library`;

    await meter.step(`search the catalogue for "${params.query}"`, async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".hit", { timeout: 45_000 });
    });
    meter.countPage(url);
    ctx.assertWithinLimits();

    const batches = Math.ceil(params.max / PER_BATCH);
    for (let batch = 1; batch < batches; batch++) {
      const before = await page.$$eval(".hit", (h) => h.length);
      if (before >= params.max) break;

      const loaded = await meter.step(`load results past ${before}`, async () => {
        const button = page.getByRole("button", { name: /load more results/i }).first();
        if (!(await button.isVisible().catch(() => false))) return false;

        await button.click();
        await page.waitForTimeout(CLICK_DELAY_MS);
        // Wait for the count to actually grow rather than sleeping and hoping.
        await page
          .waitForFunction((n) => document.querySelectorAll(".hit").length > n, before, {
            timeout: 30_000,
          })
          .catch(() => {
            /* the catalogue ran out of results; not a failure */
          });
        return true;
      });

      if (!loaded) break; // no button means every result is already on the page
      meter.countPage(`${url}#batch-${batch + 1}`);
      ctx.assertWithinLimits();
    }

    const raw = await page.$$eval(".hit", (hits) =>
      hits.map((h) => ({
        id: h.getAttribute("id") ?? "",
        title: (h.querySelector(".hit-title") as HTMLElement | null)?.innerText?.trim() ?? "",
        text: (h as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      })),
    );

    return raw
      .filter((r) => r.id && r.title)
      .slice(0, params.max)
      .map((r) => parseHitText(r.id, r.title, r.text));
  },
};
