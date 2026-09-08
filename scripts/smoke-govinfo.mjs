/**
 * Live smoke test for the govinfo adapter.
 *
 * Also demonstrates the claim the adapter is here to make: the same URL fetched plainly
 * returns an empty application shell, while the browser flow returns real data. That
 * contrast is the argument for pay-per-job over pay-per-fetch, made on a real site.
 */
import { chromium } from "playwright";
import { price } from "../packages/protocol/src/index.ts";
import { govinfoAdapter, runJob } from "../packages/worker/src/index.ts";

const URL = "https://www.govinfo.gov/app/collection/FR";

// --- what a plain fetch gets ----------------------------------------------------
const shell = await fetch(URL).then((r) => r.text());
console.log("=== what a plain GET returns ===");
console.log(`bytes            ${shell.length}`);
console.log(`mentions "Register"  ${/Federal Register/i.test(shell)}`);
console.log(`accordion markup     ${/accordion-button/.test(shell)}`);
console.log(`any issue dates      ${/\d{4}-\d{2}-\d{2}/.test(shell)}`);

// --- what the job gets ----------------------------------------------------------
const browser = await chromium.launch({ headless: true });
try {
  const params = { year: 2025, month: 1, max: 8 };
  console.log(`\n=== what the job returns === ${JSON.stringify(params)}`);

  const t0 = Date.now();
  const res = await runJob(govinfoAdapter, params, {
    browser,
    onStep: (e) => console.log(`  step ${e.steps}: ${e.label} (${e.sessionMs}ms)`),
  });

  const charged = price(
    { steps: res.work.steps, pages: res.work.pages, sessionMs: res.work.sessionMs },
    govinfoAdapter.spec.priceBook,
  );
  const plan = govinfoAdapter.plan(govinfoAdapter.normalise(params));
  const quoted = price(
    { steps: plan.steps, pages: plan.pages, sessionMs: plan.estimatedMs },
    govinfoAdapter.spec.priceBook,
  );

  console.log(`\nissues found     ${res.items.length}`);
  for (const i of res.items.slice(0, 5)) {
    console.log(`  ${i.date}  ${i.weekday.padEnd(10)} pages ${i.pageStart}-${i.pageEnd} (${i.pageCount})`);
  }
  console.log(`\nwork             ${res.work.steps} steps, ${res.work.pages} pages, ${res.work.sessionMs}ms`);
  console.log(`quoted           ${quoted.total} tinybar`);
  console.log(`actual work at   ${charged.total} tinybar`);
  console.log(`wall clock       ${Date.now() - t0}ms`);
} finally {
  await browser.close();
}
