import { chromium } from "playwright";
import { price } from "../packages/protocol/src/index.ts";
import { runJob, virgoAdapter } from "../packages/worker/src/index.ts";

const URL = "https://search.lib.virginia.edu/search?q=keyword:%20climate%20change&pool=uva_library";
const shell = await fetch(URL).then((r) => r.text());
console.log("=== what a plain GET returns ===");
console.log(`bytes             ${shell.length}`);
console.log(`mentions climate  ${/climate/i.test(shell)}`);
console.log(`any .hit markup   ${/class="hit"/.test(shell)}`);

const browser = await chromium.launch({ headless: true });
try {
  const params = { query: "climate change", max: 25 };
  console.log(`\n=== the job === ${JSON.stringify(params)}`);
  const res = await runJob(virgoAdapter, params, {
    browser,
    onStep: (e) => console.log(`  step ${e.steps}: ${e.label} (${e.sessionMs}ms)`),
  });
  const p = price({ steps: res.work.steps, pages: res.work.pages, sessionMs: res.work.sessionMs }, virgoAdapter.spec.priceBook);
  console.log(`\nrecords  ${res.items.length}`);
  for (const r of res.items.slice(0, 4)) {
    console.log(`  ${String(r.year ?? "----")}  ${(r.format ?? "?").padEnd(9)} ${r.title.slice(0, 58)}`);
    console.log(`        ${r.author ?? "(no author)"} | ${r.library ?? "-"} | ${r.callNumber ?? "-"}`);
  }
  console.log(`\nwork     ${res.work.steps} steps, ${res.work.pages} pages, ${res.work.sessionMs}ms -> ${p.total} tinybar`);
} finally {
  await browser.close();
}
