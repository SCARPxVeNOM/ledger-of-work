import type { PriceBook, StepLog } from "@low/protocol";

/**
 * What a capability estimates it will cost *before* doing the work.
 *
 * On Hedera the only available x402 scheme is `exact`, so a buyer must sign for a single
 * definite amount. There is no "authorize a maximum, settle the actual". That makes the
 * plan load-bearing: it is where the price comes from, and it must be derivable without
 * touching the network, or quoting would cost as much as the job.
 */
export interface Plan {
  /** Navigations and interactions the flow expects to perform. */
  steps: number;
  /** Result pages it expects to traverse. */
  pages: number;
  /** Expected session time, used only for the quote. */
  estimatedMs: number;
  /** Human-readable outline, returned to the buyer so the quote is legible. */
  outline: string[];
}

/** A capability's declaration, published in the manifest so a buyer can price it. */
export interface CapabilitySpec {
  /** Stable id, `<site>.<action>`. */
  name: string;
  /** The site this capability works against. */
  site: string;
  description: string;
  priceBook: PriceBook;
  /** Hard stops. A runaway flow on a hostile site is the one way this design loses money. */
  limits: {
    maxSteps: number;
    maxPages: number;
    maxSessionMs: number;
  };
}

/** Counters the runtime maintains while a job executes. */
export interface Meter {
  /** Wrap one navigation or interaction. Increments the step count and records the URL. */
  step<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Record that a result page was traversed. */
  countPage(url: string): void;
  /** Current counts, for ceiling checks mid-flight. */
  snapshot(): StepLog;
}

/** Everything a capability needs to do its work, with the meter already wired in. */
export interface JobContext<Page = unknown> {
  page: Page;
  meter: Meter;
  /** Rejects with `JobAbortedError` once a ceiling is crossed. */
  assertWithinLimits(): void;
}

/**
 * One multi-step flow against one site.
 *
 * Split deliberately into three parts with different testability:
 *   - `plan` is pure, so quoting is free and the price is reproducible.
 *   - `parse` is pure over HTML, so extraction is unit-testable with no browser.
 *   - `run` drives the browser, and is the only part that needs the network.
 */
export interface SiteAdapter<Params, Item> {
  spec: CapabilitySpec;
  /** Validate and normalise buyer-supplied parameters. Throws on bad input. */
  normalise(params: unknown): Params;
  /** Pure. Estimates the work, and therefore the price, without touching the network. */
  plan(params: Params): Plan;
  /**
   * Anything that must be checked before a price is committed to, and that needs the
   * network to check. Optional; most capabilities have nothing to do here.
   *
   * Exists because `normalise` is synchronous and some refusals are not knowable without
   * a lookup — whether a hostname resolves somewhere private, whether a site's robots.txt
   * permits the path. Those could be left to `run`, and a failed job settles nothing so
   * nobody is charged either way, but being refused *after* signing a payment is a poor
   * experience for something knowable a second earlier. Throw `BadParamsError` to refuse.
   */
  precheck?(params: Params): Promise<void>;
  /** Pure. Extracts items from one page of HTML. */
  parse(html: string): Item[];
  /** Drives the browser. Every navigation goes through `ctx.meter.step`. */
  run(ctx: JobContext<import("playwright").Page>, params: Params): Promise<Item[]>;
  /**
   * Which single response carries the answer, so an attestor can be asked to witness it.
   *
   * Optional, and honestly so: zkTLS proves one HTTPS response, while most of these jobs
   * are multi-step sessions whose answer is assembled from several. An adapter that
   * cannot point at one response should not implement this, and an adapter that can
   * should return null whenever this particular job's answer did not come from one —
   * a paginated run, say. Returning something unprovable is worse than returning
   * nothing, because a failed proof attempt costs the buyer time for no benefit.
   *
   * `mustContain` must be text the raw response body actually holds. Extracted values
   * are read from the rendered DOM, which is not the same string when the page renders
   * client-side, and an attestor asked to find text that is not in the bytes will simply
   * refuse.
   */
  provable?(
    params: Params,
    items: Item[],
    context: { finalUrl: string; html: string },
  ): { url: string; mustContain: string } | null;
}

export class JobAbortedError extends Error {
  constructor(
    message: string,
    readonly reason: "steps" | "pages" | "time",
    readonly work: StepLog,
  ) {
    super(message);
    this.name = "JobAbortedError";
  }
}

export class BadParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadParamsError";
  }
}
