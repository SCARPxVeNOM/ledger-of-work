import {
  toRestTxId,
  verifyReceipt,
  type CheckResult,
  type PriceBook,
  type Receipt,
  type VerifyOutput,
} from "@low/protocol";
import { MirrorClient, type MirrorClientOptions } from "./mirror.js";

export interface VerifyRequest {
  topicId: string;
  sequenceNumber: number;
  /** The result the buyer holds, already parsed from their file. */
  result: unknown;
  /** The account the service publishes receipts from. */
  expectedSubmitter: string;
  /** Published unit prices for the capability. Without it the meter check cannot run. */
  priceBook?: PriceBook;
}

export interface FullVerifyOutput extends VerifyOutput {
  receipt?: Receipt;
  /** Everything needed to re-run these checks by hand, printed for the sceptical. */
  evidence: {
    mirrorUrl: string;
    messageUrl: string;
    transactionUrl?: string;
    hashscanTopicUrl: string;
    hashscanTransactionUrl?: string;
  };
}

/**
 * Verify a receipt end to end from public inputs only.
 *
 * Takes a topic, a sequence number, and the buyer's result file. It never touches the
 * seller's database, needs no credentials, and can be run by someone who assumes we are
 * lying — which is the only kind of verification worth anything.
 *
 * Fetching the settlement transaction is best-effort: if it cannot be resolved, the
 * payment checks are reported as failed rather than quietly skipped. A verifier that
 * downgrades an unverifiable claim to a passing one is worse than no verifier.
 */
export async function verifyFromMirror(
  request: VerifyRequest,
  options: MirrorClientOptions = {},
): Promise<FullVerifyOutput> {
  const mirror = new MirrorClient(options);
  const message = await mirror.topicMessage(request.topicId, request.sequenceNumber);

  // Peek at the receipt to find the settlement transaction. Parse failures are left for
  // verifyReceipt to report properly rather than being thrown here.
  let txId: string | undefined;
  try {
    const peeked = JSON.parse(Buffer.from(message.message, "base64").toString("utf8")) as Receipt;
    txId = peeked.payment?.txId;
  } catch {
    /* verifyReceipt will report the parse failure */
  }

  let transaction: Awaited<ReturnType<MirrorClient["transaction"]>> | undefined;
  let transactionError: string | undefined;
  if (txId) {
    try {
      transaction = await mirror.transaction(txId);
    } catch (err) {
      transactionError = (err as Error).message;
    }
  }

  const output = verifyReceipt({
    result: request.result,
    message,
    expectedSubmitter: request.expectedSubmitter,
    priceBook: request.priceBook,
    transaction,
  });

  const checks: CheckResult[] = transactionError
    ? output.checks.map((c) =>
        c.id === "payment" ? { ...c, ok: false, detail: `could not resolve settlement: ${transactionError}` } : c,
      )
    : output.checks;

  // Use the shared converter rather than an inline replace — the whole reason
  // toRestTxId exists is that hand-rolled versions corrupt the account id.
  const restTxId = txId ? toRestTxId(txId) : undefined;

  return {
    ...output,
    checks,
    ok: checks.every((c) => c.ok),
    evidence: {
      mirrorUrl: mirror.baseUrl,
      messageUrl: `${mirror.baseUrl}/topics/${request.topicId}/messages/${request.sequenceNumber}`,
      ...(restTxId ? { transactionUrl: `${mirror.baseUrl}/transactions/${restTxId}` } : {}),
      hashscanTopicUrl: `https://hashscan.io/testnet/topic/${request.topicId}`,
      ...(txId ? { hashscanTransactionUrl: `https://hashscan.io/testnet/transaction/${txId}` } : {}),
    },
  };
}

/** Render checks for a terminal. One line each, so a failure is obvious at a glance. */
export function formatChecks(checks: CheckResult[]): string {
  const width = Math.max(...checks.map((c) => c.label.length));
  return checks
    .map((c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.label.padEnd(width)}  ${c.detail}`)
    .join("\n");
}
