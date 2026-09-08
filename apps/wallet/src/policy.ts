import { HBAR_ASSET } from "@low/protocol";

export interface SpendPolicy {
  /** Refuse any single payment above this, in the asset's smallest units. */
  maxPerPayment: string;
  /** Refuse once cumulative spend since start exceeds this. */
  maxTotal: string;
  /** Only these assets may be spent. Empty means HBAR only. */
  allowedAssets: string[];
  /** Only these accounts may be paid. Empty means anyone. */
  allowedRecipients: string[];
}

export const DEFAULT_POLICY: SpendPolicy = {
  maxPerPayment: "5000000", // 0.05 HBAR
  maxTotal: "100000000", // 1 HBAR
  allowedAssets: [],
  allowedRecipients: [],
};

export interface PaymentRequest {
  amount: string;
  asset: string;
  payTo: string;
}

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * The wallet's own judgement about a payment, made before anything is signed.
 *
 * A wallet that signs whatever it is handed is a key sitting in a network service. These
 * limits are what make it a wallet: the holder decides the ceiling once, and no amount
 * of persuasion from a seller — or from a compromised buying agent — moves it.
 *
 * Amounts are compared as integers in the asset's own smallest units, because that is
 * what gets signed and what the facilitator checks.
 */
export function checkPolicy(
  request: PaymentRequest,
  policy: SpendPolicy,
  spentSoFar: bigint,
): PolicyVerdict {
  let amount: bigint;
  try {
    amount = BigInt(request.amount);
  } catch {
    return { allowed: false, reason: `amount "${request.amount}" is not an integer` };
  }
  if (amount <= 0n) {
    return { allowed: false, reason: "amount must be positive" };
  }

  const allowedAssets = policy.allowedAssets.length ? policy.allowedAssets : [HBAR_ASSET];
  if (!allowedAssets.includes(request.asset)) {
    return {
      allowed: false,
      reason: `asset ${request.asset} is not in this wallet's allowed list (${allowedAssets.join(", ")})`,
    };
  }

  if (policy.allowedRecipients.length && !policy.allowedRecipients.includes(request.payTo)) {
    return { allowed: false, reason: `${request.payTo} is not an allowed recipient` };
  }

  if (amount > BigInt(policy.maxPerPayment)) {
    return {
      allowed: false,
      reason: `${amount} exceeds the per-payment limit of ${policy.maxPerPayment}`,
    };
  }

  // Checked against the total *including* this payment, so the limit is a ceiling on
  // spend rather than a threshold that one large payment can vault over.
  if (spentSoFar + amount > BigInt(policy.maxTotal)) {
    return {
      allowed: false,
      reason: `${amount} would take total spend to ${spentSoFar + amount}, over the limit of ${policy.maxTotal}`,
    };
  }

  return { allowed: true };
}

/** Running total of what this wallet has signed for, so `maxTotal` means something. */
export class SpendLedger {
  #spent = new Map<string, bigint>();

  record(asset: string, amount: string): void {
    this.#spent.set(asset, (this.#spent.get(asset) ?? 0n) + BigInt(amount));
  }

  spent(asset: string): bigint {
    return this.#spent.get(asset) ?? 0n;
  }

  summary(): Record<string, string> {
    return Object.fromEntries([...this.#spent].map(([k, v]) => [k, v.toString()]));
  }
}
