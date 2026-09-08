/**
 * Reconnaissance only, for UVa Library's Virgo catalogue.
 *
 * Public bibliographic data, no authentication, no robots.txt served at all. This makes
 * a handful of requests, paces itself, and identifies itself honestly.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "LedgerOfWork/0.1 (+https://github.com/SCARPxVeNOM/ledger-of-work)",
});
const page = await ctx.newPage();

try {
  await page.goto(
    "https://search.lib.virginia.edu/search?q=keyword:%20climate%20change&pool=uva_library",
    { waitUntil: "domcontentloaded", timeout: 60000 },
  );
  await page.waitForSelector(".hit", { timeout: 30000 });
  await page.waitForTimeout(3000);

  const out = await page.evaluate(() => {
    const hits = [...document.querySelectorAll(".hit")];
    const first = hits[0];
    return {
      hitCount: hits.length,
      firstHtml: first ? first.outerHTML.slice(0, 1400) : null,
      firstText: first ? first.innerText.replace(/\s+/g, " ").slice(0, 260) : null,
      total: (document.body.innerText.match(/Showing ([\d,]+) results?/i) ?? [])[1] ?? null,
      // How does one get to page 2?
      pagerButtons: [...document.querySelectorAll("button, a")]
        .map((b) => (b.innerText || b.getAttribute("aria-label") || "").trim())
        .filter((t) => /next|more|page|\bload\b/i.test(t) && t.length < 40)
        .slice(0, 12),
    };
  });

  console.log(`hits on page  ${out.hitCount}`);
  console.log(`total results ${out.total}`);
  console.log(`pager         ${out.pagerButtons.join(" | ") || "(none found)"}`);
  console.log(`\nfirst hit text:\n${out.firstText}`);
  console.log(`\nfirst hit html:\n${out.firstHtml}`);
} finally {
  await browser.close();
}
