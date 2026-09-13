/**
 * Refresh a quote with less than this left rather than spending it.
 *
 * The seller gives a quote five minutes, then deletes the job — from that moment both the
 * run url and the event stream 404. The margin has to cover everything that happens after
 * the check, and what happens is a human: the bytes go to a phone, someone unlocks it,
 * finds the wallet and approves. That is tens of seconds on a good run.
 *
 * Two minutes, because the two mistakes do not cost the same. Too small and the quote
 * passes the check, dies during the approval, and the buyer has signed a payment for a
 * job that no longer exists — nothing is charged, since the seller 404s before settling
 * anything, but they approved for nothing and are told only that it failed. Too large and
 * the page spends one extra request on a quote that would have been fine. Against a
 * five-minute life this still leaves three minutes to approve in.
 */
export const QUOTE_REFRESH_MARGIN_MS = 120_000;

/**
 * Is this quote too close to the end of its life to pay against?
 *
 * Unparseable or absent expiry counts as stale. The alternative is treating a quote of
 * unknown age as good, which is how the 502 happened in the first place — and a needless
 * re-quote costs one request, while a wrong "still fresh" costs the buyer their payment
 * attempt and tells them nothing useful.
 */
export function quoteIsStale(expiresAt: string | undefined, now: number = Date.now()): boolean {
  const at = Date.parse(expiresAt ?? "");
  if (Number.isNaN(at)) return true;
  return at - now < QUOTE_REFRESH_MARGIN_MS;
}
