/**
 * Refresh a quote this close to lapsing rather than spending it.
 *
 * The seller gives a quote five minutes, then deletes the job — from that moment both the
 * run url and the event stream 404. Paying is not instant: the signature goes to a phone
 * and comes back at human speed, and pairing a wallet can spend most of the window before
 * the buyer even presses the button. So a quote that passes this check must still outlive
 * the approval that follows it, not merely be alive right now.
 */
export const QUOTE_REFRESH_MARGIN_MS = 20_000;

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
