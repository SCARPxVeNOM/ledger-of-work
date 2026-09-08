import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { AssetSpec, PriceBook } from "@low/protocol";

export interface Quote {
  jobId: string;
  capability: string;
  params: unknown;
  /**
   * What the plan expects to do, shown to the buyer so the price is legible and written
   * into the receipt so a verifier can confirm the quote followed the price book.
   */
  plan: { steps: number; pages: number; estimatedMs: number; outline: string[] };
  /** Integer tinybars — the metered price, independent of how it is paid. */
  amount: string;
  /** The asset the buyer will actually pay in. */
  asset: AssetSpec;
  /** `amount` converted into that asset's smallest units. This is what gets signed. */
  assetAmount: string;
  priceBook: PriceBook;
  expiresAt: string;
  createdAt: number;
}

/** Quotes are short-lived so a buyer cannot bank a cheap one and redeem it much later. */
export const QUOTE_TTL_MS = 5 * 60_000;

export interface QuoteStoreOptions {
  /** Where to persist. Omit for an in-memory store (tests, ephemeral deployments). */
  path?: string | undefined;
  now?: () => number;
}

/**
 * Outstanding quotes, surviving a restart.
 *
 * A quote is a price commitment: the buyer has been told what a job costs and may be
 * partway through signing for it. Losing that on a deploy means their signed payment
 * arrives against a job the seller no longer recognises — they have committed funds for
 * a 404. Holding quotes only in memory made every restart a small breach of that
 * commitment.
 *
 * Persistence is a single JSON file written atomically. That is enough because quotes
 * are few, tiny, and expire in five minutes; a database would be more machinery than the
 * problem deserves. Writes go to a temp file and are renamed over the target, so a crash
 * mid-write leaves the previous good file rather than a truncated one.
 */
export class QuoteStore {
  readonly #quotes = new Map<string, Quote>();
  readonly #path: string | undefined;
  readonly #now: () => number;

  constructor(options: QuoteStoreOptions = {}) {
    this.#path = options.path;
    this.#now = options.now ?? Date.now;
    if (this.#path) this.#load();
  }

  create(
    capability: string,
    params: unknown,
    plan: Quote["plan"],
    amount: string,
    priceBook: PriceBook,
    asset: AssetSpec,
    assetAmount: string,
  ): Quote {
    const quote: Quote = {
      jobId: randomUUID(),
      capability,
      params,
      plan,
      amount,
      asset,
      assetAmount,
      priceBook,
      createdAt: this.#now(),
      expiresAt: new Date(this.#now() + QUOTE_TTL_MS).toISOString(),
    };
    this.#quotes.set(quote.jobId, quote);
    this.#persist();
    return quote;
  }

  get(jobId: string): Quote | undefined {
    const quote = this.#quotes.get(jobId);
    if (!quote) return undefined;
    if (this.#now() - quote.createdAt > QUOTE_TTL_MS) {
      this.#quotes.delete(jobId);
      this.#persist();
      return undefined;
    }
    return quote;
  }

  /** A quote is consumed on use, so one payment cannot buy two jobs. */
  consume(jobId: string): Quote | undefined {
    const quote = this.get(jobId);
    if (quote) {
      this.#quotes.delete(jobId);
      this.#persist();
    }
    return quote;
  }

  sweep(): void {
    const cutoff = this.#now() - QUOTE_TTL_MS;
    let removed = false;
    for (const [id, q] of this.#quotes) {
      if (q.createdAt < cutoff) {
        this.#quotes.delete(id);
        removed = true;
      }
    }
    if (removed) this.#persist();
  }

  get size(): number {
    return this.#quotes.size;
  }

  /**
   * Expired quotes are dropped at load rather than restored.
   *
   * A quote that expired while the process was down is not honourable — the price may no
   * longer reflect the price book, and reviving it would let a restart extend a deadline
   * the buyer was told about.
   */
  #load(): void {
    const path = this.#path as string;
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { quotes?: Quote[] };
      const cutoff = this.#now() - QUOTE_TTL_MS;
      for (const q of raw.quotes ?? []) {
        if (q?.jobId && typeof q.createdAt === "number" && q.createdAt >= cutoff) {
          this.#quotes.set(q.jobId, q);
        }
      }
    } catch {
      // A corrupt file must not stop the seller from starting. Quotes are recoverable by
      // asking for a new one; refusing to boot is the worse failure.
    }
  }

  #persist(): void {
    if (!this.#path) return;
    const path = this.#path;
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const body = JSON.stringify({ quotes: [...this.#quotes.values()] });
      // Write, flush to disk, then rename. Without the fsync a crash can leave the
      // rename durable but the contents not.
      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* nothing useful to do */
      }
      // Persistence is a durability improvement, not a correctness requirement: a seller
      // that cannot write its quote file should still serve quotes from memory.
    }
  }
}
