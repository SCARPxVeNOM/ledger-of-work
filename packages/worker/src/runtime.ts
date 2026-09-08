import { chromium, type Browser, type Page } from "playwright";
import type { StepLog } from "@low/protocol";
import { WorkMeter, type StepEvent } from "./meter.js";
import { JobAbortedError, type JobContext, type SiteAdapter } from "./types.js";

export interface RunResult<Item> {
  items: Item[];
  work: StepLog;
  /** Source URLs dropped to keep the receipt in one chunk, if any. */
  truncatedSources: number;
  startedAt: string;
  finishedAt: string;
}

export interface RuntimeOptions {
  /** Reuse one browser across jobs; launching Chromium is ~300ms we should not bill for. */
  browser?: Browser;
  headless?: boolean;
  /** Identify ourselves rather than pretending to be a human browser. */
  userAgent?: string;
  /** Observe the meter as it runs. Used to stream a live count to a watching UI. */
  onStep?: (event: StepEvent) => void;
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

    return {
      items,
      work,
      truncatedSources: meter.truncatedSources,
      startedAt,
      finishedAt: new Date().toISOString(),
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
