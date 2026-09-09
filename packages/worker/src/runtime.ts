import { chromium, type Browser, type Page } from "playwright";
import type { StepLog } from "@low/protocol";
import { WorkMeter, type StepEvent } from "./meter.js";
import { JobAbortedError, type JobContext, type SiteAdapter } from "./types.js";

/**
 * What the job saw, captured at the moment it finished.
 *
 * The receipt commits to hashes of these and the buyer receives the artifacts
 * themselves. It does not make fabrication impossible — a determined seller could render
 * a convincing page — but it raises the cost from "edit one field in a JSON file" to
 * "produce a full page and a matching screenshot that a human will look at".
 */
export interface Evidence {
  /** Fully rendered HTML of the final page, after scripts ran. */
  html: string;
  /** Full-page PNG. */
  screenshot: Buffer;
  /** Where the browser actually ended up, which may differ from where it was sent. */
  finalUrl: string;
  capturedAt: string;
}

export interface RunResult<Item> {
  items: Item[];
  work: StepLog;
  /** Source URLs dropped to keep the receipt in one chunk, if any. */
  truncatedSources: number;
  startedAt: string;
  finishedAt: string;
  /** Absent when the page could not be captured; never a reason to fail a paid job. */
  evidence?: Evidence;
}

export interface RuntimeOptions {
  /** Reuse one browser across jobs; launching Chromium is ~300ms we should not bill for. */
  browser?: Browser;
  headless?: boolean;
  /** Identify ourselves rather than pretending to be a human browser. */
  userAgent?: string;
  /** Observe the meter as it runs. Used to stream a live count to a watching UI. */
  onStep?: (event: StepEvent) => void;
  /** Capture page HTML and a screenshot when the job finishes. Default true. */
  captureEvidence?: boolean;
}

export const DEFAULT_USER_AGENT =
  "LedgerOfWork/0.1 (+https://github.com/SCARPxVeNOM/ledger-of-work)";

/**
 * Runs one job end to end and returns the items alongside the work performed.
 *
 * The browser context is created fresh per job and disposed afterwards, so one buyer's
 * session, cookies and login never leak into another's — which matters here because the
 * flows deliberately log in.
 *
 * Timing starts when the context is ready, not when the browser launches: a buyer should
 * not pay for our cold start.
 */
/**
 * Capture what the page looked like when the job ended.
 *
 * Deliberately never throws. The buyer has already paid by the time this runs, and
 * failing a completed job because a screenshot did not render would be the wrong trade —
 * the receipt simply records no evidence hashes, which the verifier reports rather than
 * glosses over.
 */
async function captureEvidence(page: Page): Promise<Evidence | undefined> {
  try {
    const [html, screenshot] = await Promise.all([
      page.content(),
      page.screenshot({ fullPage: true, type: "png" }),
    ]);
    return {
      html,
      screenshot,
      finalUrl: page.url(),
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

export async function runJob<Params, Item>(
  adapter: SiteAdapter<Params, Item>,
  rawParams: unknown,
  options: RuntimeOptions = {},
): Promise<RunResult<Item>> {
  const params = adapter.normalise(rawParams);

  const ownBrowser = !options.browser;
  const browser =
    options.browser ?? (await chromium.launch({ headless: options.headless ?? true }));

  const context = await browser.newContext({
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
  });

  const meter = new WorkMeter({
    limits: adapter.spec.limits,
    ...(options.onStep ? { onStep: options.onStep } : {}),
  });
  const startedAt = new Date().toISOString();

  let page: Page | undefined;
  try {
    page = await context.newPage();
    const ctx: JobContext<Page> = {
      page,
      meter,
      assertWithinLimits: () => meter.assertWithinLimits(),
    };

    const items = await adapter.run(ctx, params);
    const work = meter.snapshot();
    const evidence =
      options.captureEvidence === false ? undefined : await captureEvidence(page);

    return {
      items,
      work,
      truncatedSources: meter.truncatedSources,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...(evidence ? { evidence } : {}),
    };
  } catch (err) {
    // A ceiling breach is not an unexpected failure — it is the designed response to a
    // flow that would overrun its quote. Surface the work done so the caller can still
    // publish a `failed` receipt: a log that only records successes proves nothing.
    if (err instanceof JobAbortedError) throw err;
    throw new JobAbortedError(
      `job failed: ${(err as Error).message}`,
      "steps",
      meter.snapshot(),
    );
  } finally {
    await page?.close().catch(() => {});
    await context.close().catch(() => {});
    if (ownBrowser) await browser.close().catch(() => {});
  }
}
