import { consensusTimestampToMillis, type Receipt } from "@low/protocol";
import { MirrorClient, type MirrorClientOptions } from "./mirror.js";

export interface UsageReport {
  topicId: string;
  /** Receipts read. Every job ever run against this topic, successful or not. */
  jobs: number;
  succeeded: number;
  failed: number;
  /** Accounts that have paid for at least one job. The closest thing to a user count. */
  distinctPayers: number;
  payers: string[];
  /** Settled totals per denomination, as integer strings. */
  revenue: Record<string, string>;
  /** How many jobs each capability has served. */
  byCapability: Record<string, number>;
  /** Total metered work across all jobs. */
  work: { steps: number; pages: number; sessionMs: number };
  firstAt: string | null;
  lastAt: string | null;
  /** Receipts that could not be parsed — reported rather than quietly dropped. */
  unreadable: number;
}

/**
 * Aggregate usage from receipts.
 *
 * Pure, so the numbers can be checked against a fixture, and so anyone can recompute
 * them from the same public messages. That is the point of doing it this way at all: a
 * usage claim on a slide is unfalsifiable, whereas this is derived from an append-only
 * public log that the seller cannot edit. Anyone can run it against the topic and get
 * the same answer, including someone trying to prove the numbers are inflated.
 *
 * Failed jobs count as jobs and contribute no revenue. Excluding them would flatter the
 * success rate, which is the one number a reader is most entitled to distrust.
 */
export function summariseUsage(
  topicId: string,
  entries: Array<{ receipt: Receipt | null; consensusTimestamp: string }>,
): UsageReport {
  const payers = new Set<string>();
  const revenue = new Map<string, bigint>();
  const byCapability: Record<string, number> = {};
  const work = { steps: 0, pages: 0, sessionMs: 0 };

  let succeeded = 0;
  let failed = 0;
  let unreadable = 0;
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const { receipt, consensusTimestamp } of entries) {
    const ms = consensusTimestampToMillis(consensusTimestamp);
    if (ms < firstMs) {
      firstMs = ms;
      firstAt = new Date(ms).toISOString();
    }
    if (ms > lastMs) {
      lastMs = ms;
      lastAt = new Date(ms).toISOString();
    }

    if (!receipt) {
      unreadable++;
      continue;
    }

    if (receipt.status === "ok") succeeded++;
    else failed++;

    byCapability[receipt.capability] = (byCapability[receipt.capability] ?? 0) + 1;

    work.steps += receipt.work?.steps ?? 0;
    work.pages += receipt.work?.pages ?? 0;
    work.sessionMs += receipt.work?.sessionMs ?? 0;

    // A payer is only counted once they have actually paid. A failed job charges zero,
    // so counting its payer would inflate the user number with people who paid nothing.
    const charged = BigInt(receipt.price?.charged ?? "0");
    if (charged > 0n) {
      if (receipt.payment?.payer) payers.add(receipt.payment.payer);
      const unit = receipt.price.unit;
      revenue.set(unit, (revenue.get(unit) ?? 0n) + charged);
    }
  }

  return {
    topicId,
    jobs: entries.length,
    succeeded,
    failed,
    distinctPayers: payers.size,
    payers: [...payers].sort(),
    revenue: Object.fromEntries([...revenue].map(([k, v]) => [k, v.toString()])),
    byCapability,
    work,
    firstAt,
    lastAt,
    unreadable,
  };
}

/**
 * Read every receipt on a topic and summarise it.
 *
 * Reads through the public mirror node with no credentials, so this is not the seller
 * reporting its own numbers — it is a computation anyone can repeat.
 */
export async function readUsage(
  topicId: string,
  options: MirrorClientOptions & { limit?: number } = {},
): Promise<UsageReport> {
  const mirror = new MirrorClient(options);
  const messages = await mirror.recentMessages(topicId, options.limit ?? 100);

  const entries = messages.map((m) => {
    let receipt: Receipt | null = null;
    try {
      receipt = JSON.parse(Buffer.from(m.message, "base64").toString("utf8")) as Receipt;
    } catch {
      receipt = null;
    }
    return { receipt, consensusTimestamp: m.consensus_timestamp };
  });

  return summariseUsage(topicId, entries);
}

/** Render a report for a terminal or a README. */
export function formatUsage(report: UsageReport): string {
  const lines: string[] = [];
  const successRate = report.jobs ? Math.round((report.succeeded / report.jobs) * 100) : 0;

  lines.push(`topic            ${report.topicId}`);
  lines.push(`jobs             ${report.jobs}  (${report.succeeded} ok, ${report.failed} failed, ${successRate}% success)`);
  lines.push(`paying accounts  ${report.distinctPayers}`);
  for (const [unit, total] of Object.entries(report.revenue)) {
    lines.push(`revenue          ${total} ${unit}`);
  }
  lines.push(`work metered     ${report.work.steps} steps, ${report.work.pages} pages, ${Math.round(report.work.sessionMs / 1000)}s`);
  lines.push("capabilities");
  for (const [name, count] of Object.entries(report.byCapability).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(4)}  ${name}`);
  }
  lines.push(`first job        ${report.firstAt ?? "-"}`);
  lines.push(`latest job       ${report.lastAt ?? "-"}`);
  if (report.unreadable) lines.push(`unreadable       ${report.unreadable}`);
  return lines.join("\n");
}
