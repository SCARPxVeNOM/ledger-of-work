import {
  hashCanonical,
  sha256,
  toRestTxId,
  verifyReceipt,
  type CheckResult,
  type AssetSpec,
  type PriceBook,
  type Receipt,
  type VerifyOutput,
} from "@low/protocol";
import {
  checkCoverage,
  checkRetrievalProof,
  hashProof,
  type RetrievalProof,
} from "@low/proof";
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
  /** Needed to check the meter when the receipt settled in an HTS token. */
  asset?: AssetSpec;
  /**
   * The page HTML and screenshot the buyer was given. Omit them and the evidence checks
   * report unproven rather than passing.
   */
  pageHtml?: string;
  screenshot?: Buffer;
  /**
   * The retrieval proof the buyer was given. Omit it and the retrieval checks report
   * unproven — including the signature check, which is the only one whose subject the
   * seller could not have manufactured.
   */
  retrievalProof?: RetrievalProof;
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

  // Decide the retrieval questions that need the proof in hand. The hash and the
  // coverage go into the shared verifier so the browser page reports them identically;
  // the signature check is appended afterwards because it is asynchronous and needs the
  // attestor SDK, neither of which the portable core can have.
  const peekedRetrieval = (() => {
    try {
      const r = JSON.parse(Buffer.from(message.message, "base64").toString("utf8")) as Receipt;
      return { url: r.evidence?.finalUrl, hasRetrieval: Boolean(r.retrieval) };
    } catch {
      return { url: undefined, hasRetrieval: false };
    }
  })();

  const coverage =
    request.retrievalProof && peekedRetrieval.url
      ? checkCoverage({
          proof: request.retrievalProof,
          expectedUrl: peekedRetrieval.url,
          answer: JSON.stringify(request.result),
        })
      : undefined;

  const output = verifyReceipt({
    // Hashing happens here rather than inside verifyReceipt, so that function stays
    // synchronous and portable enough to bundle for the browser verifier.
    resultHash: hashCanonical(request.result),
    // Hashed exactly as the seller hashed them: raw bytes, no canonicalisation, because
    // these are opaque artifacts rather than structured data.
    ...(request.pageHtml !== undefined
      ? { pageHash: sha256(Buffer.from(request.pageHtml, "utf8")) }
      : {}),
    ...(request.screenshot ? { screenshotHash: sha256(request.screenshot) } : {}),
    ...(request.retrievalProof ? { retrievalProofHash: hashProof(request.retrievalProof) } : {}),
    ...(coverage ? { retrievalCoverage: coverage } : {}),
    message,
    expectedSubmitter: request.expectedSubmitter,
    priceBook: request.priceBook,
    asset: request.asset,
    transaction,
  });

  let checks: CheckResult[] = transactionError
    ? output.checks.map((c) =>
        c.id === "payment" ? { ...c, ok: false, detail: `could not resolve settlement: ${transactionError}` } : c,
      )
    : output.checks;

  // The signature. Appended rather than folded in above because it is the one check that
  // cannot be synchronous, and it is worth having at all only because the key that made
  // the signature is not ours.
  if (output.receipt?.retrieval) {
    if (request.retrievalProof) {
      const proofChecks = await checkRetrievalProof({
        proof: request.retrievalProof,
        ref: output.receipt.retrieval,
        expectedUrl: output.receipt.evidence?.finalUrl ?? "",
        answer: JSON.stringify(request.result),
      });
      const signature = proofChecks.find((c) => c.id === "proof-signature");
      if (signature) checks = [...checks, signature];
    } else {
      checks = [
        ...checks,
        {
          id: "proof-signature",
          label: "An independent attestor signed this claim",
          ok: false,
          detail: `not checked — supply the proof the seller returned alongside the result`,
        },
      ];
    }
  }

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
