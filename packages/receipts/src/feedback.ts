import { canonical, canonicalByteLength, HCS_CHUNK_BYTES } from "@low/protocol";
import { MirrorClient, type MirrorClientOptions } from "./mirror.js";

/**
 * Tester feedback, on its own topic.
 *
 * Deliberately *not* the receipt topic. Receipts are a record of delivery and must stay
 * exactly that; mixing opinions into them would weaken the one log the product's claim
 * rests on.
 *
 * The topic is created with **no submit key**, which is the whole point. Anyone with a
 * Hedera account can post to it directly, so a tester's criticism is attributable to
 * their account and cannot be edited or quietly dropped by us afterwards. An open topic
 * also means we cannot be the sole author of our own reviews.
 *
 * What that does *not* prove: entries we post ourselves are self-reported. The honest
 * reading of an entry is "posted by account X at time T", and where X is the seller's
 * own account it carries no more weight than a claim in a README. `readFeedback` reports
 * the submitter for exactly this reason.
 */

export const FEEDBACK_VERSION = 1;

export interface Feedback {
  v: typeof FEEDBACK_VERSION;
  kind: "feedback";
  /** How the tester wants to be known. Free text; no verification is claimed. */
  from: string;
  /** Which capability they bought, if any. */
  capability?: string;
  /** Did they know the price and why, before paying? */
  priceWasLegible?: boolean;
  /** Did they verify the receipt? */
  didVerify?: boolean;
  /** What they wanted to buy that the catalogue does not sell. */
  wanted?: string;
  /** Anything else. Kept short so a record stays inside one HCS chunk. */
  notes?: string;
  at: string;
}

export class FeedbackTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `feedback is ${bytes} bytes and would be split across HCS chunks; shorten \`notes\` (limit ${HCS_CHUNK_BYTES}).`,
    );
    this.name = "FeedbackTooLargeError";
  }
}

/** Build and validate a feedback record. Pure, so the shape is testable without a network. */
export function buildFeedback(input: Omit<Feedback, "v" | "kind" | "at"> & { at?: string }): Feedback {
  const from = input.from?.trim();
  if (!from) throw new Error("`from` is required — anonymous feedback is not attributable");
  if (from.length > 60) throw new Error("`from` must be 60 characters or fewer");

  const record: Feedback = {
    v: FEEDBACK_VERSION,
    kind: "feedback",
    from,
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.priceWasLegible === undefined ? {} : { priceWasLegible: input.priceWasLegible }),
    ...(input.didVerify === undefined ? {} : { didVerify: input.didVerify }),
    ...(input.wanted ? { wanted: input.wanted.slice(0, 300) } : {}),
    ...(input.notes ? { notes: input.notes.slice(0, 500) } : {}),
    at: input.at ?? new Date().toISOString(),
  };

  const bytes = canonicalByteLength(record);
  if (bytes > HCS_CHUNK_BYTES) throw new FeedbackTooLargeError(bytes);
  return record;
}

/** Canonical bytes for submission, so a reader can reproduce them exactly. */
export function feedbackBytes(feedback: Feedback): Buffer {
  return Buffer.from(canonical(feedback), "utf8");
}

export interface FeedbackEntry {
  feedback: Feedback | null;
  /** The account that actually posted. This, not `from`, is what is attributable. */
  submitter: string;
  sequenceNumber: number;
  consensusTimestamp: string;
  /**
   * True when the entry came from an account the project controls.
   *
   * Checked against *every* project account, not just the seller's. The first entry on
   * this topic was posted from the buyer account and would otherwise have been counted
   * as external feedback — which is precisely the flattering mistake this flag exists to
   * prevent.
   */
  selfReported: boolean;
}

/**
 * Read a feedback topic.
 *
 * Flags entries posted by the seller's own account. A reader deserves to know which
 * criticism arrived from outside and which the seller typed in themselves.
 */
export async function readFeedback(
  topicId: string,
  options: MirrorClientOptions & { limit?: number; ownAccounts?: string[] } = {},
): Promise<FeedbackEntry[]> {
  const mirror = new MirrorClient(options);
  const messages = await mirror.recentMessages(topicId, options.limit ?? 100);

  return messages.map((m) => {
    let feedback: Feedback | null = null;
    try {
      feedback = JSON.parse(Buffer.from(m.message, "base64").toString("utf8")) as Feedback;
    } catch {
      feedback = null;
    }
    return {
      feedback,
      submitter: m.payer_account_id,
      sequenceNumber: m.sequence_number,
      consensusTimestamp: m.consensus_timestamp,
      selfReported: (options.ownAccounts ?? []).includes(m.payer_account_id),
    };
  });
}

/** Render feedback for a terminal, keeping the self-reported flag visible. */
export function formatFeedback(entries: FeedbackEntry[]): string {
  if (!entries.length) return "No feedback yet.";

  const external = entries.filter((e) => !e.selfReported && e.feedback).length;
  const lines = [
    `${entries.length} entries, ${external} from accounts the project does not control`,
    "",
  ];

  for (const e of entries) {
    if (!e.feedback) {
      lines.push(`#${e.sequenceNumber}  (unreadable)`);
      continue;
    }
    const f = e.feedback;
    lines.push(`#${e.sequenceNumber}  ${f.from}${e.selfReported ? "  [self-reported]" : ""}`);
    lines.push(`     posted by ${e.submitter} at ${f.at}`);
    if (f.capability) lines.push(`     bought    ${f.capability}`);
    if (f.priceWasLegible !== undefined) lines.push(`     price clear before paying: ${f.priceWasLegible ? "yes" : "no"}`);
    if (f.didVerify !== undefined) lines.push(`     verified the receipt:      ${f.didVerify ? "yes" : "no"}`);
    if (f.wanted) lines.push(`     wanted    ${f.wanted}`);
    if (f.notes) lines.push(`     notes     ${f.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}
