/** HBAR is spelled `0.0.0` as an x402 asset id; anything else is an HTS token. */
export const HBAR_ASSET = "0.0.0";

export interface AssetSpec {
  /** x402 `asset` field: `0.0.0` or an HTS token id. */
  id: string;
  symbol: string;
  decimals: number;
  /**
   * How many of this asset's smallest units equal one tinybar.
   *
   * The meter prices everything in tinybars because that is the unit the network itself
   * uses and the one a price book is published in. Charging in another asset therefore
   * needs a rate, and the rate must be declared rather than fetched: a price a buyer
   * cannot reproduce from the manifest is not a published price.
   */
  unitsPerTinybar: string;
}

export const HBAR: AssetSpec = {
  id: HBAR_ASSET,
  symbol: "HBAR",
  decimals: 8,
  unitsPerTinybar: "1",
};

export function isHbar(asset: string): boolean {
  return asset === HBAR_ASSET;
}

/**
 * Convert a tinybar price into an asset's smallest units.
 *
 * Integer arithmetic throughout, and rounds **up**. The exact scheme rejects a payment
 * that credits less than `amount`, so rounding down would silently under-bill and then
 * fail verification; rounding up costs the buyer at most one unit and always settles.
 */
export function tinybarToAssetUnits(tinybar: string | bigint, asset: AssetSpec): string {
  const t = BigInt(tinybar);
  if (t < 0n) throw new RangeError("tinybarToAssetUnits: amount must not be negative");

  const [whole, frac = ""] = asset.unitsPerTinybar.split(".");
  if (frac.length > 18) throw new RangeError("unitsPerTinybar has too many decimal places");

  // Scale the rate to an integer so no floating point enters a price.
  const scale = 10n ** BigInt(frac.length);
  const rate = BigInt(whole as string) * scale + (frac ? BigInt(frac) : 0n);

  const numerator = t * rate;
  // Ceiling division.
  return ((numerator + scale - 1n) / scale).toString();
}

/** Display helper. Never round-trip a price through this. */
export function formatAssetAmount(units: string | bigint, asset: AssetSpec): string {
  const u = BigInt(units);
  if (asset.decimals === 0) return `${u} ${asset.symbol}`;
  const d = 10n ** BigInt(asset.decimals);
  const whole = u / d;
  const frac = (u % d).toString().padStart(asset.decimals, "0");
  return `${whole}.${frac} ${asset.symbol}`;
}
