import type { PriceBook, StepLog } from "./types.js";

/** Work summary as recorded in a receipt — the sources list is not priced. */
export type PricedWork = Omit<StepLog, "sources">;

export interface PriceBreakdown {
  base: bigint;
  steps: bigint;
  pages: bigint;
  seconds: bigint;
  /** Sum before the ceiling is applied. */
  subtotal: bigint;
  /** What is actually charged: `min(subtotal, ceiling)`. */
  total: bigint;
  /** True when the ceiling bound the price — the job should have aborted instead. */
  ceilingHit: boolean;
}

/**
 * The meter.
 *
 * Deliberately a pure function of the *recorded* work and the *published* price book. It
 * never re-runs the job, never consults a clock, and never reads a database. That is what
 * lets an independent verifier recompute the charge from `receipt.work` alone and assert
 * that the price corresponds to the work claimed — the check nobody else in this category
 * makes.
 *
 * Session time is billed per whole second, rounded up, so a job cannot dodge the time
 * component by finishing at 1.9s.
 */
export function price(work: PricedWork, book: PriceBook): PriceBreakdown {
  assertCountable(work);

  const base = BigInt(book.base);
  const steps = BigInt(book.perStep) * BigInt(work.steps);
  const pages = BigInt(book.perPage) * BigInt(work.pages);
  const seconds = BigInt(book.perSecond) * BigInt(Math.ceil(work.sessionMs / 1000));

  const subtotal = base + steps + pages + seconds;
  const ceiling = BigInt(book.ceiling);
  const ceilingHit = subtotal > ceiling;

  return {
    base,
    steps,
    pages,
    seconds,
    subtotal,
    total: ceilingHit ? ceiling : subtotal,
    ceilingHit,
  };
}

/** Convenience: the charge as the tinybar string that goes on the wire and in the receipt. */
export function priceTinybars(work: PricedWork, book: PriceBook): string {
  return price(work, book).total.toString();
}

function assertCountable(work: PricedWork): void {
  for (const [key, value] of Object.entries(work)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`price: work.${key} must be a non-negative integer, got ${value}`);
    }
  }
}
