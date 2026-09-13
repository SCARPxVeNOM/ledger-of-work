import type { PriceBook, StepLog } from "./types.js";

/** Work summary as recorded in a receipt — the sources list is not priced. */
export type PricedWork = Omit<StepLog, "sources">;

export interface PriceBreakdown {
  base: bigint;
  steps: bigint;
  pages: bigint;
  seconds: bigint;
  /** Everything charged at a rate the price book names itself. Zero for a web job. */
  named: bigint;
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
export function price(work: Record<string, number>, book: PriceBook): PriceBreakdown {
  assertCountable(work);

  // The reserved three keep dedicated rates rather than moving into `per`, so every
  // receipt already on the topic prices to the number it already records. Absent means
  // zero: a service that meters tokens performs no steps, and should not be asked to
  // record a zero to say so.
  const base = BigInt(book.base);
  const steps = BigInt(book.perStep) * BigInt(work.steps ?? 0);
  const pages = BigInt(book.perPage) * BigInt(work.pages ?? 0);
  const seconds = BigInt(book.perSecond) * BigInt(Math.ceil((work.sessionMs ?? 0) / 1000));

  /**
   * Everything else, at the rate the book names for it.
   *
   * An unpriced unit throws rather than costing nothing. Charging zero for work the book
   * forgot to price is a loss the seller is never told about, and it would happen on
   * every job until somebody reconciled the books by hand.
   */
  let named = 0n;
  for (const [unit, count] of Object.entries(work)) {
    if (unit === "steps" || unit === "pages" || unit === "sessionMs") continue;
    const rate = book.per?.[unit];
    if (rate === undefined) {
      throw new TypeError(`price: the price book has no rate for \`${unit}\``);
    }
    named += BigInt(rate) * BigInt(count);
  }

  const subtotal = base + steps + pages + seconds + named;
  const ceiling = BigInt(book.ceiling);
  const ceilingHit = subtotal > ceiling;

  return {
    base,
    steps,
    pages,
    seconds,
    named,
    subtotal,
    total: ceilingHit ? ceiling : subtotal,
    ceilingHit,
  };
}

/** Convenience: the charge as the tinybar string that goes on the wire and in the receipt. */
export function priceTinybars(work: Record<string, number>, book: PriceBook): string {
  return price(work, book).total.toString();
}

function assertCountable(work: Record<string, number>): void {
  for (const [key, value] of Object.entries(work)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`price: work.${key} must be a non-negative integer, got ${value}`);
    }
  }
}
