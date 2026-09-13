import { fitsOneChunk, verifySignature, type PriceBook, type Receipt } from "@low/protocol";

export interface RelayDeps {
  /** Publish to the adopter's own topic, paying the fee from our account. */
  submit: (topic: string, receipt: Receipt) => Promise<{ topicId: string; sequenceNumber: number }>;
  /** Look the signer up in the public directory. */
  resolve: (uaid: string) => Promise<{ topic: string; publicKey: string; book: PriceBook } | null>;
  verify: (bytes: string, sig: string) => boolean;
  /** How many receipts one identity may relay. Every one spends our HBAR. */
  quotaPerIdentity: number;
}

export type RelayResult = { ok: true; topic: string } | { ok: false; error: string };

/**
 * Submits receipts it did not write and cannot forge.
 *
 * ── Why this is allowed to exist ────────────────────────────────────────────────
 * Every check below defends our own wallet, not the buyer. The buyer verifies
 * independently against a public topic and needs nothing from us — which is exactly what
 * makes a relay acceptable in a design whose whole claim is that you need not trust
 * anyone. If this component were load-bearing for the buyer's confidence, it would be the
 * middleman the project exists to remove.
 *
 * The consequence worth stating: if we refuse an adopter, or disappear, they lose a
 * convenience and nothing else. They hold the key and own the topic, and can publish
 * directly.
 */
export class Relay {
  /** `${identity}:${jobId}` of everything already submitted. */
  readonly #seen = new Set<string>();
  readonly #count = new Map<string, number>();

  constructor(private readonly deps: RelayDeps) {}

  async accept(receipt: Receipt): Promise<RelayResult> {
    const sig = receipt.sig;
    if (!sig) {
      return { ok: false, error: "receipt is not signed; there is nothing to check it against" };
    }

    if (!fitsOneChunk(receipt)) {
      // Trimming would change the bytes the signature covers, so this is the signer's to
      // fix. Doing it here would publish something that fails to verify.
      return { ok: false, error: "receipt is over one HCS chunk; shrink it before signing" };
    }

    const listed = await this.deps.resolve(sig.by);
    if (!listed) {
      return {
        ok: false,
        error: `${sig.by} is not in the directory; publish a listing with a public key first`,
      };
    }

    if (!verifySignature(receipt, this.deps.verify)) {
      return { ok: false, error: "signature does not verify against the listed key" };
    }

    const key = `${sig.by}:${receipt.jobId}`;
    if (this.#seen.has(key)) {
      return { ok: false, error: `job ${receipt.jobId} was already relayed for ${sig.by}` };
    }

    const used = this.#count.get(sig.by) ?? 0;
    if (used >= this.deps.quotaPerIdentity) {
      return { ok: false, error: `${sig.by} has reached its relay quota of ${this.deps.quotaPerIdentity}` };
    }

    // The directory decides where this goes, not the receipt. A receipt naming its own
    // destination would let any signer write into somebody else's ledger.
    await this.deps.submit(listed.topic, receipt);

    this.#seen.add(key);
    this.#count.set(sig.by, used + 1);
    return { ok: true, topic: listed.topic };
  }
}
