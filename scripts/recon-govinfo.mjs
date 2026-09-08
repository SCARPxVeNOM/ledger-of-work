/**
 * Reconnaissance only. govinfo is an Angular app whose browse tree is nested collapsed
 * accordions — year, then month, then day — each loading its children only when clicked.
 * A plain fetch returns a ~1.7KB shell, so this has to be driven for real.
 *
 * robots.txt disallows /search/ and /index.php/search/. It does NOT disallow /app/.
 * This script only visits /app/collection paths.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: "LedgerOfWork/0.1 (+https://github.com/SCARPxVeNOM/ledger-of-work)",
});
const page = await ctx.newPage();

const expandedButtons = () =>
  page.$$eval(".accordion-button", (bs) =>
    bs
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ text: b.innerText.trim().slice(0, 40), expanded: b.getAttribute("aria-expanded") })),
  );

try {
  await page.goto("https://www.govinfo.gov/app/collection/FR", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForSelector(".accordion-button", { timeout: 25000 });
  await page.waitForTimeout(1500);

  await page.click('.accordion-button:has-text("2025 (Volume 90)")');
  await page.waitForTimeout(2500);
  await page.click('.accordion-button:has-text("January")');
  await page.waitForTimeout(3000);

  const visible = await expandedButtons();
  console.log(`visible accordion buttons after year+month: ${visible.length}`);
  console.log(visible.slice(0, 20).map((b) => `  [${b.expanded}] ${b.text}`).join("\n"));

  // A day-level control should look like a date.
  const dayLike = visible.filter((b) => /\d{1,2}\/\d{1,2}\/\d{4}|January \d|\d{4}-\d{2}-\d{2}/i.test(b.text));
  console.log(`\nday-like buttons: ${dayLike.length} -> ${dayLike.slice(0, 5).map((d) => d.text).join(" | ")}`);

  if (dayLike.length) {
    console.log(`\nexpanding day: ${dayLike[0].text}`);
    await page.click(`.accordion-button:has-text("${dayLike[0].text}")`);
    await page.waitForTimeout(3500);
    const links = await page.$$eval("a[href*='/app/details/']", (as) =>
      [...new Set(as.map((a) => a.getAttribute("href")))].filter((h) => /\d{4}-\d{2}-\d{2}/.test(h)),
    );
    console.log(`dated detail links now: ${links.length}`);
    console.log(`  ${links.slice(0, 6).join("\n  ")}`);

    const titles = await page.$$eval(".result-title", (ts) =>
      ts.map((t) => t.innerText.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 6),
    );
    console.log(`\nresult titles:\n  ${titles.join("\n  ")}`);
  }
} finally {
  await browser.close();
}
