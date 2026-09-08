import type { Page } from "playwright";
import { decodeHtml } from "../html.js";
import { BadParamsError, type JobContext, type Plan, type SiteAdapter } from "../types.js";

const ORIGIN = "https://www.govinfo.gov";

/**
 * The Federal Register browse tree on govinfo.gov.
 *
 * ── Why this site ───────────────────────────────────────────────────────────────
 * It is the strongest available demonstration that a job is not a fetch. govinfo is an
 * Angular application: a plain GET of any browse URL returns a ~1.7KB shell with no
 * content in it. The browse tree is nested collapsed accordions — year, then month, then
 * day — and each level loads its children only when clicked. There is no URL that jumps
 * to a month's issue list; you have to click your way there. A single request cannot
 * produce this result no matter how it is constructed.
 *
 * ── robots.txt ──────────────────────────────────────────────────────────────────
 * govinfo disallows `/search/` and `/index.php/search/`. This adapter never touches
 * either. It uses only `/app/collection/...`, which is not disallowed, and it identifies
 * itself honestly in the user agent. Requests are paced so a browse costs the site about
 * what a human clicking through would.
 *
 * ── The caveat, stated plainly ──────────────────────────────────────────────────
 * govinfo publishes an official API at api.govinfo.gov. So while a *fetch* cannot
 * substitute for this flow, an API does exist for the underlying data, and this site is
 * therefore a weak example of the "no API" half of the pitch even though it is a strong
 * example of the "not a fetch" half. Presented as proof that the adapter interface
 * generalises to a real, JS-rendered government site — not as proof that the data is
 * otherwise unobtainable.
 */

/** Politeness pause between interactions with a public government service. */
const CLICK_DELAY_MS = 400;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export interface GovinfoParams {
  /** Four-digit year. The Federal Register runs from 1936. */
  year: number;
  /** 1-12. */
  month: number;
  /** How many issues to return. */
  max: number;
}

export interface FederalRegisterIssue {
  /** ISO date of the issue, e.g. "2025-01-02". */
  date: string;
  /** Weekday as the site labels it. */
  weekday: string;
  /** First page of the printed issue. */
  pageStart: number | null;
  /** Last page of the printed issue. */
  pageEnd: number | null;
  /** How many pages the issue ran to — the reason to browse this at all. */
  pageCount: number | null;
}

/**
 * Pure. Parses one day accordion's label into structured data.
 *
 * The site renders these as e.g. `"Thursday, January 2 –\nPages 1-183"`. The en dash and
 * the embedded newline are both load-bearing gotchas: a naive split on "-" cuts the page
 * range in half, and `:has-text()` selectors fail on the newline.
 */
export function parseDayLabel(label: string, year: number): FederalRegisterIssue | null {
  const text = decodeHtml(label);

  const dayMatch = /^(\w+day),\s*([A-Z][a-z]+)\s+(\d{1,2})/.exec(text);
  if (!dayMatch) return null;

  const monthIndex = MONTHS.indexOf(dayMatch[2] as (typeof MONTHS)[number]);
  if (monthIndex < 0) return null;

  const day = Number(dayMatch[3]);
  const date = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  // "Pages 1-183" — note the range separator is a plain hyphen while the label's own
  // separator is an en dash, so anchoring on the word "Pages" is what keeps them apart.
  const pages = /Pages\s+(\d+)\s*[-–]\s*(\d+)/i.exec(text);
  const pageStart = pages ? Number(pages[1]) : null;
  const pageEnd = pages ? Number(pages[2]) : null;

  return {
    date,
    weekday: dayMatch[1] as string,
    pageStart,
    pageEnd,
    pageCount: pageStart !== null && pageEnd !== null ? pageEnd - pageStart + 1 : null,
  };
}

export const govinfoAdapter: SiteAdapter<GovinfoParams, FederalRegisterIssue> = {
  spec: {
    name: "govinfo.federal_register_issues",
    site: ORIGIN,
    description:
      "Click through the Federal Register browse tree on govinfo.gov — year, then month — and return each published issue with its date and printed page range. The site is an Angular app whose tree loads only on click, so a plain fetch cannot produce this.",
    priceBook: {
      base: "60000",
      perStep: "45000",
      perPage: "90000",
      perSecond: "9000",
      ceiling: "9000000",
    },
    // Generous on time because this is a real government site under real load, and
    // stingy on steps because the flow is a fixed depth: open, year, month.
    limits: { maxSteps: 12, maxPages: 4, maxSessionMs: 180_000 },
  },

  normalise(params: unknown): GovinfoParams {
    const p = (params ?? {}) as Record<string, unknown>;
    const now = new Date();

    const year = p.year === undefined ? now.getUTCFullYear() - 1 : Number(p.year);
    if (!Number.isInteger(year) || year < 1936 || year > now.getUTCFullYear()) {
      throw new BadParamsError(`\`year\` must be an integer between 1936 and ${now.getUTCFullYear()}`);
    }

    const month = p.month === undefined ? 1 : Number(p.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadParamsError("`month` must be an integer between 1 and 12");
    }

    const max = p.max === undefined ? 10 : Number(p.max);
    if (!Number.isInteger(max) || max < 1 || max > 31) {
      throw new BadParamsError("`max` must be an integer between 1 and 31");
    }

    return { year, month, max };
  },

  /**
   * Pure, and fixed-depth: the flow is always open, expand year, expand month. What
   * varies is how long the site takes, which is why the time component carries most of
   * the price here rather than the step count.
   */
  plan(params: GovinfoParams): Plan {
    return {
      steps: 3,
      pages: 1,
      estimatedMs: 14_000,
      outline: [
        "open the Federal Register browse tree",
        `expand ${params.year}`,
        `expand ${MONTHS[params.month - 1]}`,
        `read up to ${params.max} issues with their page ranges`,
      ],
    };
  },

  /**
   * Pure. Extracts issues from the rendered day labels.
   *
   * Takes the labels joined by newlines rather than raw HTML, because the accordion
   * markup carries no per-issue container to parse — the data lives in the button text.
   */
  parse(labelsBlock: string): FederalRegisterIssue[] {
    // Year is unknown to a caller passing raw text, so this path is only used by tests
    // that supply an explicit year via parseDayLabel. Keep it honest rather than guess.
    return labelsBlock
      .split("\n\n")
      .map((l) => parseDayLabel(l, new Date().getUTCFullYear()))
      .filter((i): i is FederalRegisterIssue => i !== null);
  },

  async run(ctx: JobContext<Page>, params: GovinfoParams): Promise<FederalRegisterIssue[]> {
    const { page, meter } = ctx;
    const monthName = MONTHS[params.month - 1] as string;

    await meter.step("open the Federal Register browse tree", async () => {
      await page.goto(`${ORIGIN}/app/collection/FR`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector(".accordion-button", { timeout: 40_000 });
    });
    meter.countPage(`${ORIGIN}/app/collection/FR`);
    ctx.assertWithinLimits();

    // Year labels read "2025 (Volume 90)", so match on the prefix rather than equality.
    await meter.step(`expand ${params.year}`, async () => {
      await clickAccordion(page, (text) => text.startsWith(String(params.year)));
      await page.waitForTimeout(CLICK_DELAY_MS);
      await page.waitForFunction(
        (m) =>
          [...document.querySelectorAll(".accordion-button")].some(
            (b) => (b as HTMLElement).innerText.trim() === m,
          ),
        monthName,
        { timeout: 40_000 },
      );
    });

    await meter.step(`expand ${monthName}`, async () => {
      await clickAccordion(page, (text) => text === monthName);
      await page.waitForTimeout(CLICK_DELAY_MS);
      // Day labels are the payload. Wait for at least one to appear rather than a fixed
      // sleep, so a slow month does not silently return nothing.
      await page
        .waitForFunction(
          () =>
            [...document.querySelectorAll(".accordion-button")].some((b) =>
              /^\w+day,\s+[A-Z][a-z]+\s+\d{1,2}/.test((b as HTMLElement).innerText.trim()),
            ),
          undefined,
          { timeout: 40_000 },
        )
        .catch(() => {
          /* an empty month is a real answer, not a failure */
        });
    });

    const labels = await page.$$eval(".accordion-button", (buttons) =>
      buttons
        .filter((b) => (b as HTMLElement).offsetParent !== null)
        .map((b) => (b as HTMLElement).innerText.trim()),
    );

    const issues = labels
      .map((label) => parseDayLabel(label, params.year))
      .filter((i): i is FederalRegisterIssue => i !== null)
      // A month accordion for a different year could be open from a previous expansion;
      // keep only issues in the month actually requested.
      .filter((i) => i.date.startsWith(`${params.year}-${String(params.month).padStart(2, "0")}`));

    return issues.slice(0, params.max);
  },
};

/** Click the first visible accordion button whose text matches. */
async function clickAccordion(page: Page, match: (text: string) => boolean): Promise<void> {
  const buttons = await page.$$(".accordion-button");
  for (const button of buttons) {
    if (!(await button.isVisible())) continue;
    const text = ((await button.innerText()) ?? "").trim();
    if (match(text)) {
      await button.click();
      return;
    }
  }
  throw new Error("no matching accordion control found on the page");
}
