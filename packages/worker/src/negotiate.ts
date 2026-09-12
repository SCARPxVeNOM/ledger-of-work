import { priceTinybars, type PriceBook } from "@low/protocol";
import type { Plan, SiteAdapter } from "./types.js";

/**
 * Fitting a job to a buyer's budget.
 *
 * ── What is negotiable here, and what is not ────────────────────────────────────
 * Not the price. The price is a pure function of the work and a price book published
 * before the job ran, and the verifier checks exactly that — `Quote follows the published
 * price book` is a red check on every receipt where the two disagree. A seller that
 * discounts for a good haggler has broken its own audit trail, so haggling is the one
 * thing this must not do.
 *
 * What is negotiable is **scope**. "A hundred records" and "as many records as 400,000
 * tinybar buys" are different requests, and the second one is what an agent with a budget
 * actually means. So the seller answers a budget it cannot meet with the largest piece of
 * the job that fits, at the published rate, and lets the buyer decide.
 *
 * That distinction is the reason this is worth having at all. Two agents agreeing on the
 * shape of the work before committing to it is negotiation; two agents agreeing to ignore
 * a published rate card is just a discount with extra steps.
 */

/** What the seller is willing to do, and what it would cost. */
export interface Offer<Params> {
  params: Params;
  plan: Plan;
  /** Tinybars, as a string, exactly as the quote and the receipt will carry it. */
  priceTinybar: string;
}

/**
 * Price a set of parameters without touching the network.
 *
 * `plan` is pure by contract, which is what makes counter-offers free — the seller can
 * consider a dozen alternative scopes for the cost of arithmetic.
 */
export function offerFor<P, I>(adapter: SiteAdapter<P, I>, params: P): Offer<P> {
  const plan = adapter.plan(params);
  return {
    params,
    plan,
    priceTinybar: priceTinybars(
      { steps: plan.steps, pages: plan.pages, sessionMs: plan.estimatedMs },
      adapter.spec.priceBook,
    ),
  };
}

/** Why no counter-offer could be made. Each is a different thing to tell the buyer. */
export type NoFitReason =
  /** The capability has no numeric scope dial, so there is nothing to trade away. */
  | "not-divisible"
  /** Even the smallest job this capability can do costs more than the budget. */
  | "floor-above-budget";

export type Fit<P> =
  | { kind: "fits"; offer: Offer<P> }
  | { kind: "counter"; offer: Offer<P>; asked: Offer<P> }
  | { kind: "no-fit"; reason: NoFitReason; floor: Offer<P> };

/**
 * The scope dial.
 *
 * Every capability in the catalogue takes `max` — how many records to return — and it is
 * the only parameter that means "how much of this do you want". Checked rather than
 * assumed: a capability without it is reported as `not-divisible` instead of being
 * silently offered unchanged, because quietly returning the full-price job to an agent
 * that said it had a budget is a worse answer than "no".
 */
function scopeOf(params: unknown): number | null {
  if (typeof params !== "object" || params === null) return null;
  const max = (params as { max?: unknown }).max;
  return typeof max === "number" && Number.isInteger(max) && max > 0 ? max : null;
}

function withScope<P>(params: P, max: number): P {
  return { ...(params as object), max } as P;
}

/**
 * The largest version of this job that costs no more than `budgetTinybar`.
 *
 * Binary search over the scope dial rather than a linear walk down from the asked-for
 * size: a request for ten thousand records should not cost ten thousand calls to `plan`
 * to answer, and `plan` being pure means the search is pure too.
 *
 * The search assumes price does not *fall* as scope grows, which holds for every adapter
 * here — more records means more pages and never fewer. It is an assumption rather than a
 * law, so the result is verified before it is returned: whatever the search lands on is
 * priced once more and checked against the budget, and a violation is reported as no fit
 * rather than sold. A counter-offer that turns out to cost more than the buyer agreed is
 * the one outcome worse than refusing.
 */
export function fitToBudget<P, I>(
  adapter: SiteAdapter<P, I>,
  params: P,
  budgetTinybar: string,
): Fit<P> {
  const budget = BigInt(budgetTinybar);
  const asked = offerFor(adapter, params);
  if (BigInt(asked.priceTinybar) <= budget) return { kind: "fits", offer: asked };

  const requested = scopeOf(params);
  if (requested === null) {
    return { kind: "no-fit", reason: "not-divisible", floor: asked };
  }

  // One record is the smallest this capability can be asked to do. If even that is too
  // dear, no amount of trimming helps and the buyer should be told the floor price.
  const floor = offerFor(adapter, withScope(params, 1));
  if (BigInt(floor.priceTinybar) > budget) {
    return { kind: "no-fit", reason: "floor-above-budget", floor };
  }

  let lo = 1;
  let hi = requested;
  let best = floor;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = offerFor(adapter, withScope(params, mid));
    if (BigInt(candidate.priceTinybar) <= budget) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Trust the arithmetic, verify the answer.
  if (BigInt(best.priceTinybar) > budget) {
    return { kind: "no-fit", reason: "floor-above-budget", floor };
  }
  return { kind: "counter", offer: best, asked };
}

/** How a price book converts to a settlement asset, when the buyer is not paying in HBAR. */
export function describeBook(book: PriceBook): string {
  return `base ${book.base}, ${book.perStep}/step, ${book.perPage}/page, ${book.perSecond}/s, ceiling ${book.ceiling}`;
}
