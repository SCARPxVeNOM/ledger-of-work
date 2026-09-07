import { toRestTxId, type MirrorTopicMessage, type MirrorTransaction } from "@low/protocol";

export const MIRROR_URLS = {
  testnet: "https://testnet.mirrornode.hedera.com/api/v1",
  mainnet: "https://mainnet.mirrornode.hedera.com/api/v1",
  previewnet: "https://previewnet.mirrornode.hedera.com/api/v1",
} as const;

export interface MirrorClientOptions {
  baseUrl?: string;
  /** Mirror nodes lag consensus by a second or two; a fresh write 404s until it catches up. */
  retries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export class MirrorNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found on the mirror node after all retries`);
    this.name = "MirrorNotFoundError";
  }
}

/**
 * Read-only client for the public mirror node.
 *
 * Keyless and unauthenticated by design: the verifier must be runnable by someone who
 * does not trust the seller and has no credentials, and this is the path that makes that
 * true. It is also CORS-open, so the same code runs in a browser page.
 */
export class MirrorClient {
  readonly baseUrl: string;
  readonly #retries: number;
  readonly #delay: number;
  readonly #fetch: typeof fetch;

  constructor(options: MirrorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? MIRROR_URLS.testnet).replace(/\/$/, "");
    this.#retries = options.retries ?? 8;
    this.#delay = options.retryDelayMs ?? 1000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch one topic message by sequence number, tolerating mirror lag.
   *
   * A 404 immediately after a write means "not yet", not "never" — treating the two the
   * same would make the verifier report a forged receipt for a perfectly good one.
   */
  async topicMessage(topicId: string, sequenceNumber: number): Promise<MirrorTopicMessage> {
    const url = `${this.baseUrl}/topics/${topicId}/messages/${sequenceNumber}`;
    const found = await this.#getWithRetry<MirrorTopicMessage>(url);
    if (!found) throw new MirrorNotFoundError(`topic ${topicId} message ${sequenceNumber}`);
    return found;
  }

  /**
   * Fetch a settlement transaction.
   *
   * Accepts either spelling of the id and converts: the REST path needs
   * `0.0.x-secs-nanos` and rejects the SDK's `0.0.x@secs.nanos` with a 400.
   *
   * One transaction id can return several records — a parent plus scheduled or child
   * entries — distinguished by `nonce`. The top-level result is the `nonce: 0` one.
   */
  async transaction(transactionId: string): Promise<MirrorTransaction> {
    const url = `${this.baseUrl}/transactions/${toRestTxId(transactionId)}`;
    const body = await this.#getWithRetry<{ transactions: (MirrorTransaction & { nonce?: number })[] }>(url);
    const tx = body?.transactions?.find((t) => t.nonce === 0) ?? body?.transactions?.[0];
    if (!tx) throw new MirrorNotFoundError(`transaction ${transactionId}`);
    return tx;
  }

  /** Most recent messages on a topic, newest first. Used by the receipt browser. */
  async recentMessages(topicId: string, limit = 25): Promise<MirrorTopicMessage[]> {
    const url = `${this.baseUrl}/topics/${topicId}/messages?limit=${limit}&order=desc`;
    const body = await this.#getWithRetry<{ messages: MirrorTopicMessage[] }>(url);
    return body?.messages ?? [];
  }

  async #getWithRetry<T>(url: string): Promise<T | null> {
    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      const res = await this.#fetch(url);
      if (res.ok) return (await res.json()) as T;
      lastStatus = res.status;

      // Only 404 is worth waiting out. A 400 means a malformed id and will never
      // succeed; retrying it just makes the failure slower and the error less clear.
      if (res.status !== 404) {
        throw new Error(`mirror node returned ${res.status} for ${url}`);
      }
      if (attempt < this.#retries) {
        await new Promise((r) => setTimeout(r, this.#delay));
      }
    }
    if (lastStatus === 404) return null;
    throw new Error(`mirror node returned ${lastStatus} for ${url}`);
  }
}
