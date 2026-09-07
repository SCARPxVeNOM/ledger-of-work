/**
 * Hedera value and identifier conversions. Pure string/bigint work — no SDK, so the
 * verifier can run these without pulling in a network client.
 */

export const TINYBAR_PER_HBAR = 100_000_000n;

/**
 * Tinybars are the only unit that crosses a boundary in this system. Prices, payment
 * amounts, and receipt fields are all integer tinybar *strings* — never floats, and
 * never HBAR decimals. The x402 exact scheme rejects a mismatched amount outright, so a
 * rounding error is a failed payment, not a rounding error.
 */
export function hbarToTinybar(hbar: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(hbar)) {
    throw new TypeError(`hbarToTinybar: expected up to 8 decimal places, got "${hbar}"`);
  }
  const [whole = "0", frac = ""] = hbar.split(".");
  return BigInt(whole) * TINYBAR_PER_HBAR + BigInt(frac.padEnd(8, "0"));
}

/** Display only. Never round-trip a price through this. */
export function tinybarToHbar(tinybar: bigint | string): string {
  const t = BigInt(tinybar);
  const whole = t / TINYBAR_PER_HBAR;
  const frac = (t % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const SDK_TX_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;
const REST_TX_ID = /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/;

/**
 * The SDK, HashScan, and x402 facilitators all print a transaction id as
 * `0.0.7162784@1757304723.987654321`. The mirror node REST path rejects that with HTTP
 * 400 and wants `0.0.7162784-1757304723-987654321`.
 *
 * The naive `id.replace("@","-").replace(".","-")` corrupts the account id's own dots
 * into `0-0.7162784`, and a global replace is worse. Split on `@` first.
 */
export function toRestTxId(txId: string): string {
  if (REST_TX_ID.test(txId)) return txId;
  const m = SDK_TX_ID.exec(txId);
  if (!m) throw new TypeError(`toRestTxId: unrecognised transaction id "${txId}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function toSdkTxId(txId: string): string {
  if (SDK_TX_ID.test(txId)) return txId;
  const m = REST_TX_ID.exec(txId);
  if (!m) throw new TypeError(`toSdkTxId: unrecognised transaction id "${txId}"`);
  return `${m[1]}@${m[2]}.${m[3]}`;
}

/**
 * Consensus timestamps arrive as `seconds.nanoseconds` strings. Parsing one as a float
 * silently discards nanosecond precision and can collapse two distinct events into one,
 * so compare them as a pair of integers instead.
 */
export function parseConsensusTimestamp(ts: string): { seconds: bigint; nanos: bigint } {
  const m = /^(\d+)\.(\d{1,9})$/.exec(ts);
  if (!m) throw new TypeError(`parseConsensusTimestamp: unrecognised timestamp "${ts}"`);
  return { seconds: BigInt(m[1] as string), nanos: BigInt((m[2] as string).padEnd(9, "0")) };
}

/** Consensus timestamp as milliseconds since epoch, for comparison against ISO times. */
export function consensusTimestampToMillis(ts: string): number {
  const { seconds, nanos } = parseConsensusTimestamp(ts);
  return Number(seconds) * 1000 + Number(nanos / 1_000_000n);
}
