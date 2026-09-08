import type { StepLog } from "@low/protocol";
import { JobAbortedError, type CapabilitySpec, type Meter } from "./types.js";

/** Bounded so a receipt stays inside one 1024-byte HCS chunk. */
export const MAX_SOURCES = 8;

/** Emitted as each step completes, so a watching UI shows the real meter, not a mock. */
export interface StepEvent {
  label: string;
  steps: number;
  pages: number;
  sessionMs: number;
}

export interface MeterOptions {
  limits: CapabilitySpec["limits"];
  /** Injectable so tests are not at the mercy of a real clock. */
  now?: () => number;
  /** Called after each step. Must never throw into the job — see the guard below. */
  onStep?: (event: StepEvent) => void;
}

/**
 * Counts the work as it happens.
 *
 * The counts this produces are the *only* input to the price, and they are written into
 * the receipt verbatim so an independent verifier can recompute the charge. That makes
 * two properties non-negotiable: every unit must be countable (no judgement calls), and
 * the count must not depend on anything the seller could quietly vary after the fact.
 */
export class WorkMeter implements Meter {
  #steps = 0;
  #pages = 0;
  #sources: string[] = [];
  #truncatedSources = 0;
  readonly #start: number;
  readonly #now: () => number;
  readonly #limits: CapabilitySpec["limits"];
  readonly #onStep: ((event: StepEvent) => void) | undefined;

  constructor(options: MeterOptions) {
    this.#limits = options.limits;
    this.#now = options.now ?? Date.now;
    this.#onStep = options.onStep;
    this.#start = this.#now();
  }

  async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    // Count before running. A step that throws still consumed real work, and not
    // counting it would let a flow do unbounded work by failing repeatedly.
    this.#steps += 1;
    this.assertWithinLimits(label);
    const result = await fn();
    this.#emit(label);
    return result;
  }

  /**
   * A watcher must never be able to break a paid job. If a UI disconnects mid-stream and
   * the emitter throws, the buyer would lose work they had already paid for.
   */
  #emit(label: string): void {
    if (!this.#onStep) return;
    try {
      const { steps, pages, sessionMs } = this.snapshot();
      this.#onStep({ label, steps, pages, sessionMs });
    } catch {
      /* a broken observer is not the job's problem */
    }
  }

  countPage(url: string): void {
    this.#pages += 1;
    this.addSource(url);
  }

  addSource(url: string): void {
    if (this.#sources.includes(url)) return;
    if (this.#sources.length >= MAX_SOURCES) {
      this.#truncatedSources += 1;
      return;
    }
    this.#sources.push(url);
  }

  /** How many source URLs were dropped to keep the receipt in one chunk. */
  get truncatedSources(): number {
    return this.#truncatedSources;
  }

  snapshot(): StepLog {
    return {
      steps: this.#steps,
      pages: this.#pages,
      sessionMs: this.#now() - this.#start,
      sources: [...this.#sources],
    };
  }

  /**
   * Hard stops. Crossing one aborts the job rather than overrunning the quote — on
   * `exact` there is no way to settle for less than the agreed amount, so the only
   * honest response to a runaway flow is to stop and not charge.
   */
  assertWithinLimits(label = ""): void {
    const work = this.snapshot();
    const where = label ? ` at "${label}"` : "";
    if (work.steps > this.#limits.maxSteps) {
      throw new JobAbortedError(
        `step ceiling exceeded${where}: ${work.steps} > ${this.#limits.maxSteps}`,
        "steps",
        work,
      );
    }
    if (work.pages > this.#limits.maxPages) {
      throw new JobAbortedError(
        `page ceiling exceeded${where}: ${work.pages} > ${this.#limits.maxPages}`,
        "pages",
        work,
      );
    }
    if (work.sessionMs > this.#limits.maxSessionMs) {
      throw new JobAbortedError(
        `time ceiling exceeded${where}: ${work.sessionMs}ms > ${this.#limits.maxSessionMs}ms`,
        "time",
        work,
      );
    }
  }
}
