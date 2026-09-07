/**
 * Live smoke test for the worker.
 *
 * Runs two real jobs of deliberately different size against the live sites and prints
 * the work performed and the price it implies. The point is the *contrast*: if a small
 * job and a large job cost the same, the meter is a flat fee wearing a costume.
 */
import { chromium } from "playwright";
import { price } from "../packages/protocol/src/index.ts";
import { booksAdapter, quotesAdapter, runJob } from "../packages/worker/src/index.ts";

const browser = await chromium.launch({ headless: true });

async function run(label, adapter, params) {
  const t0 = Date.now();
  const res = await runJob(adapter, params, { browser });
  const p = price(
    { steps: res.work.steps, pages: res.work.pages, sessionMs: res.work.sessionMs },
    adapter.spec.priceBook,
  );
  const plan = adapter.plan(adapter.normalise(params));
  const quoted = price(
    { steps: plan.steps, pages: plan.pages, sessionMs: plan.estimatedMs },
    adapter.spec.priceBook,
  );

  console.log(`\n=== ${label} ===`);
  console.log(`params      ${JSON.stringify(params)}`);
  console.log(`planned     ${plan.steps} steps, ${plan.pages} pages  -> quote ${quoted.total} tinybar`);
  console.log(`actual      ${res.work.steps} steps, ${res.work.pages} pages, ${res.work.sessionMs}ms  -> ${p.total} tinybar`);
  console.log(`variance    ${p.total - quoted.total} tinybar (${p.total > quoted.total ? "absorbed by seller" : "under quote"})`);
  console.log(`items       ${res.items.length}`);
  console.log(`sources     ${res.work.sources.length}${res.truncatedSources ? ` (+${res.truncatedSources} truncated)` : ""}`);
  console.log(`sample      ${JSON.stringify(res.items[0])?.slice(0, 110)}`);
  console.log(`wall clock  ${Date.now() - t0}ms`);
  return { work: res.work, charged: p.total };
}

try {
  // Jobs chosen against measured site limits: a tag page never has more than two
  // pages, while the unfiltered listing runs to ten. Asking for 40 quotes from one tag
  // would silently return 13 and make the meter look broken when it was the data.
  const small = await run("small: 3 quotes tagged 'love' (1 page)", quotesAdapter, {
    tag: "love",
    max: 3,
  });
  const large = await run("large: 100 quotes, unfiltered (10 pages)", quotesAdapter, {
    max: 100,
  });
  const books = await run("books: nonfiction, 4+ stars, under £30", booksAdapter, {
    category: "nonfiction",
    maxPrice: 30,
    minRating: 4,
    max: 20,
  });

  console.log("\n=== the claim under test ===");
  const ratio = Number(large.charged) / Number(small.charged);
  console.log(`small ${small.work.steps} steps -> ${small.charged} tinybar`);
  console.log(`large ${large.work.steps} steps -> ${large.charged} tinybar`);
  console.log(`books ${books.work.steps} steps -> ${books.charged} tinybar`);
  console.log(
    `\nlarge/small price ratio ${ratio.toFixed(2)}x — ${ratio > 1.5 ? "the meter tracks work" : "TOO FLAT, the meter is not earning its keep"}`,
  );
} finally {
  await browser.close();
}
