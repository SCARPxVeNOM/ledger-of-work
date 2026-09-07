/**
 * Thin client for an x402 facilitator's HTTP API.
 *
 * Written against the raw endpoints rather than an SDK: the surface is four calls, and
 * doing it directly keeps every field the facilitator sees visible in one file — which
 * matters when the failure mode is a rejected payment whose reason is a field you cannot
 * see.
 */

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  /** Integer tinybars as a string. Must match what the buyer signed, exactly. */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** `0.0.0` for HBAR, or an HTS token id. */
  asset: string;
  extra: { feePayer: string };
}

export interface PaymentPayload {
  x402Version: 2;
  scheme: "exact";
  network: string;
  accepted: PaymentRequirements;
  payload: { transaction: string };
}

export interface VerifyResponse {
  isValid: boolean;
  /**
   * The buying account, on Blocky402. Capture this before settling — it is the only
   * reliable source for the payer's identity. See `resolvePayer`.
   */
  payer?: string;
  invalidReason?: string;
  invalidMessage?: string;
}

export interface SettleResponse {
  success: boolean;
  /** Blocky402 spells it `transaction`; the spec and Hedera's docs say `transactionId`. */
  transaction?: string;
  transactionId?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
}

export interface SupportedResponse {
  kinds: Array<{ scheme: string; network: string; x402Version: number; extra?: { feePayer?: string } }>;
  signers?: Record<string, string[]>;
}

export class FacilitatorError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "FacilitatorError";
  }
}

export class FacilitatorClient {
  readonly url: string;
  #feePayer: string | null = null;
  readonly #network: string;
  readonly #apiKey: string | undefined;

  constructor(options: { url: string; network: string; apiKey?: string | undefined }) {
    this.url = options.url.replace(/\/$/, "");
    this.#network = options.network;
    this.#apiKey = options.apiKey;
  }

  /**
   * Read the advertised fee payer once at boot and cache it.
   *
   * Never hardcode it: a stale fee payer is the most common cause of a rejected
   * `/verify`. Never fetch it per request either — the hosted facilitator rate-limits.
   */
  async initialise(): Promise<string> {
    const res = await fetch(`${this.url}/supported`, { headers: this.#headers() });
    if (!res.ok) throw new FacilitatorError(`/supported returned ${res.status}`);
    const body = (await res.json()) as SupportedResponse;

    const kind = body.kinds.find((k) => k.network === this.#network && k.scheme === "exact");
    if (!kind) {
      throw new FacilitatorError(
        `facilitator does not support exact on ${this.#network}; it offers ${body.kinds
          .map((k) => `${k.scheme}/${k.network}`)
          .join(", ")}`,
      );
    }
    // The fee payer is advertised in two places; prefer the per-kind one.
    const feePayer = kind.extra?.feePayer ?? body.signers?.["hedera:*"]?.[0];
    if (!feePayer) throw new FacilitatorError("facilitator advertises no fee payer");

    this.#feePayer = feePayer;
    return feePayer;
  }

  get feePayer(): string {
    if (!this.#feePayer) throw new FacilitatorError("call initialise() before using the facilitator");
    return this.#feePayer;
  }

  requirements(amount: string, payTo: string, asset = "0.0.0"): PaymentRequirements {
    return {
      scheme: "exact",
      network: this.#network,
      amount,
      payTo,
      maxTimeoutSeconds: 300,
      asset,
      extra: { feePayer: this.feePayer },
    };
  }

  /** Free and non-destructive — always call before doing billable work. */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.#post<VerifyResponse>("/verify", payload, requirements);
  }

  /** Replay-protected: a payload settles exactly once. Never retry expecting a second charge. */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.#post<SettleResponse>("/settle", payload, requirements);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async #post<T>(path: string, paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.#headers() },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
    });
    const text = await res.text();
    if (!res.ok) throw new FacilitatorError(`${path} returned ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FacilitatorError(`${path} returned unparseable body: ${text.slice(0, 200)}`);
    }
  }

  #headers(): Record<string, string> {
    return this.#apiKey ? { "X-Api-Key": this.#apiKey } : {};
  }
}

/** Read the settlement id under either spelling. */
export function settlementTxId(settle: SettleResponse): string | undefined {
  return settle.transactionId ?? settle.transaction;
}

/**
 * Determine the buying agent's account.
 *
 * Prefers `/verify`'s `payer`, because the settlement response's `payer` is not portable:
 * Blocky402 returns the buyer there, but the scheme's own field list describes it as the
 * fee payer. The transaction id is no help either — the scheme requires
 * `transactionId.accountId == feePayer`, so it always names the facilitator.
 *
 * Falls back to the settlement value only when it is neither the fee payer nor absent,
 * and returns null rather than guessing. A receipt that names the wrong paying agent is
 * worse than one that admits it does not know.
 */
export function resolvePayer(
  verify: VerifyResponse,
  settle: SettleResponse,
  feePayer: string,
): string | null {
  if (verify.payer && verify.payer !== feePayer) return verify.payer;
  if (settle.payer && settle.payer !== feePayer) return settle.payer;
  return null;
}
