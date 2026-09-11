import { canonical, canonicalByteLength, HCS_CHUNK_BYTES } from "@low/protocol";
import { MirrorClient, type MirrorClientOptions } from "./mirror.js";

/**
 * A directory of x402 services, on an open HCS topic.
 *
 * ── The problem ─────────────────────────────────────────────────────────────────
 * An agent with a budget and a task has no way to find out that this service exists. A
 * manifest is only discoverable if you already know the URL, which makes it documentation
 * rather than discovery.
 *
 * ── Why a topic rather than a server ────────────────────────────────────────────
 * The obvious answer is a directory API, and the obvious problem with a directory API is
 * that everyone has to trust whoever runs it — to list fairly, to stay up, and not to
 * quietly edit entries. That is a strange thing to require of a project whose whole claim
 * is that you need not trust the seller.
 *
 * An HCS topic with **no submit key** has none of those properties to trust. Anyone can
 * list themselves, from their own account. Nobody can delete a listing, including us.
 * Every entry carries the account that posted it, so "who claims this" is answerable
 * without asking anyone. Reading it needs no key and no permission — the mirror node is
 * public and CORS-open, so a browser can browse the directory directly.
 *
 * ── What a listing does and does not prove ──────────────────────────────────────
 * That an account said, at a consensus timestamp, that a service exists at a URL. It does
 * not prove the service works, that the prices are honest, or that the poster owns the
 * endpoint. It is a phone book, not a credential. What makes a listing checkable is the
 * `receipts` topic it names: go and read what that service has actually delivered.
 */

export const LISTING_VERSION = 1;

export interface Listing {
  v: typeof LISTING_VERSION;
  kind: "listing";
  /** HCS-14 universal agent id — the stable name, independent of the URL below. */
  uaid: string;
  name: string;
  /** Where the service answers today. */
  url: string;
  /** Capability ids and the cheapest each can cost, in tinybars. */
  skills: Array<{ id: string; from: string }>;
  /** The topic this service publishes receipts to, so a reader can check its history. */
  receipts?: string;
  network: string;
  at: string;
}

export class ListingTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `listing is ${bytes} bytes and would be split across HCS chunks, which the mirror REST API does not reassemble — shorten the name or list fewer skills (limit ${HCS_CHUNK_BYTES}).`,
    );
    this.name = "ListingTooLargeError";
  }
}

/** Build and validate a listing. Pure, so the shape is testable with no network. */
export function buildListing(
  input: Omit<Listing, "v" | "kind" | "at"> & { at?: string },
): Listing {
  if (!input.uaid?.startsWith("uaid:")) {
    throw new Error("`uaid` must be an HCS-14 identifier — a listing keyed by URL is an address");
  }
  let host: string;
  try {
    host = new URL(input.url).host;
  } catch {
    throw new Error(`\`url\` is not a valid absolute URL: ${input.url}`);
  }
  if (!host) throw new Error("`url` must name a host");

  const record: Listing = {
    v: LISTING_VERSION,
    kind: "listing",
    uaid: input.uaid,
    name: input.name.trim().slice(0, 60),
    url: input.url,
    // Bounded because the chunk limit is hard: a service with forty capabilities would
    // otherwise publish a listing nobody can read back.
    skills: input.skills.slice(0, 8),
    ...(input.receipts ? { receipts: input.receipts } : {}),
    network: input.network,
    at: input.at ?? new Date().toISOString(),
  };

  const bytes = canonicalByteLength(record);
  if (bytes > HCS_CHUNK_BYTES) throw new ListingTooLargeError(bytes);
  return record;
}

/** The exact bytes submitted, so a caller can check the size before paying to publish. */
export function listingBytes(listing: Listing): string {
  return canonical(listing);
}

export interface DirectoryEntry {
  listing: Listing;
  /** The account that posted it. The only fact here nobody can forge. */
  submitter: string;
  sequenceNumber: number;
  at: string;
}

/**
 * Read the directory.
 *
 * Later listings from the same account replace earlier ones, so a service can move host
 * or change its prices by posting again — the topic is append-only, but the *view* of it
 * is the latest word from each publisher. Keyed by `uaid` rather than by account, because
 * the identifier is the thing that is supposed to be stable.
 *
 * Entries that do not parse are skipped rather than thrown on: an open topic will collect
 * junk, and a directory that one bad message can break is not a directory.
 */
export async function readDirectory(
  topicId: string,
  options: MirrorClientOptions & { limit?: number } = {},
): Promise<DirectoryEntry[]> {
  const { limit, ...mirrorOptions } = options;
  const mirror = new MirrorClient(mirrorOptions);
  const messages = await mirror.recentMessages(topicId, limit ?? 100);

  const latest = new Map<string, DirectoryEntry>();
  for (const message of messages) {
    let listing: Listing;
    try {
      listing = JSON.parse(Buffer.from(message.message, "base64").toString("utf8")) as Listing;
    } catch {
      continue;
    }
    if (listing?.kind !== "listing" || listing.v !== LISTING_VERSION || !listing.uaid) continue;

    // An account may only speak for its own listings. Without this, anyone could
    // overwrite a competitor's entry by reposting it with a worse URL.
    const key = `${message.payer_account_id}|${listing.uaid}`;

    // Compare sequence numbers rather than trusting arrival order. The mirror node
    // returns newest-first, so folding blindly keeps the *oldest* listing — which showed
    // up as a service that had moved host still advertising the address it left.
    const seen = latest.get(key);
    if (seen && seen.sequenceNumber >= message.sequence_number) continue;

    latest.set(key, {
      listing,
      submitter: message.payer_account_id,
      sequenceNumber: message.sequence_number,
      at: message.consensus_timestamp,
    });
  }

  return [...latest.values()].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

/** Render the directory for a terminal. */
export function formatDirectory(entries: DirectoryEntry[]): string {
  if (entries.length === 0) return "  (no services listed yet)";
  return entries
    .map((e) => {
      const skills = e.listing.skills
        .map((s) => `      ${s.id.padEnd(34)} from ${s.from} tinybar`)
        .join("\n");
      return [
        `  ${e.listing.name}  (seq ${e.sequenceNumber}, posted by ${e.submitter})`,
        `    ${e.listing.url}`,
        `    ${e.listing.uaid.slice(0, 76)}…`,
        ...(e.listing.receipts ? [`    receipts  ${e.listing.receipts}`] : []),
        skills,
      ].join("\n");
    })
    .join("\n\n");
}
