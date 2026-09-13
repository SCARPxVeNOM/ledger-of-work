import { assertValidUnits, price, type PriceBook } from "@low/protocol";

/**
 * Taking payment from inside someone else's service.
 *
 * This package is the only surface an adopter writes against, and it is deliberately four
 * functions and a signature. An adopter who cannot read it has to trust it, and trust is
 * the thing this whole design is selling against — so retries, caching, dashboards and
 * metrics do not belong here, however reasonable each would sound on its own.
 *
 * What it does: price a request from a published book before doing any work, decide
 * afterwards whether anything was actually delivered, and commit to the result. What it
 * does not do: hold the adopter's data, send it anywhere, or make any decision the adopter
 * has not declared.
 */

/** What the gate is given about an incoming request. Deliberately tiny. */
export interface GateRequest {
  body: unknown;
}

export interface GateConfig<Out> {
  /** Capability id, recorded on the receipt so a buyer can price-check it afterwards. */
  capability: string;
  /** Published before the job runs, and re-checked by the verifier after it. */
  book: PriceBook;
  /** What this request will cost, in named units, decided before the work happens. */
  price: (req: GateRequest) => Record<string, number>;
  /** What the work actually consumed. Defaults to what was quoted. */
  work?: (out: Out) => Record<string, number>;
  /** Named artifacts to commit to. The values are hashed; they are never transmitted. */
  evidence?: (out: Out) => Record<string, string>;
  /**
   * Did this deliver what was sold?
   *
   * Absent means yes, which is right for a search: finding nothing is an answer, and
   * making it free would let a buyer take work for the price of a bad query. A capture is
   * the opposite — matching nothing means it did not capture anything — and should say so.
   * Only the adopter can tell which of the two they are.
   */
  delivered?: (out: Out) => { ok: true } | { ok: false; why: string };
}

/**
 * Price a request before doing any of the work.
 *
 * Units are validated here rather than when the receipt is built. A unit set the receipt
 * schema cannot carry is a mistake in the adopter's configuration, and the moment to say
 * so is the first request — not the first request that happens to produce an oversized
 * receipt, which arrives later and in front of a buyer who has paid.
 */
export function quoteFor<Out>(
  config: GateConfig<Out>,
  req: GateRequest,
): { units: Record<string, number>; amount: string } {
  const units = config.price(req);
  assertValidUnits(units, "unit");
  return { units, amount: price(units, config.book).total.toString() };
}

/**
 * Whether the buyer should be charged, now that the work is done.
 *
 * The `exact` scheme admits no partial settlement — the buyer signed for one number — so
 * the only options are that number or nothing.
 */
export function decideSettlement<Out>(
  config: GateConfig<Out>,
  out: Out,
): { settle: true } | { settle: false; why: string } {
  const verdict = config.delivered?.(out);
  if (!verdict || verdict.ok) return { settle: true };
  return { settle: false, why: verdict.why };
}
