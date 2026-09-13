import {
  assertFitsOneChunk,
  assertValidUnits,
  hashCanonical,
  RECEIPT_VERSION,
  signReceipt,
  type JobStatus,
  type Receipt,
} from "@low/protocol";
import type { GateConfig } from "./gate.js";

export interface BuildArgs<Out> {
  jobId: string;
  /** What was quoted, in named units. Used as the work record unless the adopter measures. */
  units: Record<string, number>;
  /** What the handler returned. Hashed here, and transmitted nowhere. */
  out: Out;
  amount: string;
  charged: string;
  payer: string;
  payTo: string;
  network: string;
  asset: string;
  startedAt: string;
  finishedAt: string;
  status: JobStatus;
  identity: {
    alg: "ed25519" | "ecdsa-secp256k1";
    by: string;
    sign: (bytes: string) => string;
  };
}

/**
 * Turn what happened into a signed receipt.
 *
 * ── Size is checked before signing, and that ordering is the point ──────────────
 * A receipt that is signed and only then found too large has no good option left.
 * Trimming it changes the bytes the signature covers, so it would publish and fail to
 * verify for everyone. Not publishing it leaves a job the buyer paid for with no record
 * at all. Checking first puts the failure in the adopter's own process, at configuration
 * time, where the answer is to commit to fewer artifacts.
 *
 * ── What is committed to, and what is not ───────────────────────────────────────
 * The answer is hashed, never included. So are the artifacts. A receipt is a set of
 * claims small enough to fit in 1024 bytes on a public topic, and publishing the content
 * itself would be both too large and, for most adopters, a disclosure they never agreed
 * to.
 */
export function buildReceipt<Out>(config: GateConfig<Out>, args: BuildArgs<Out>): Receipt {
  const work = config.work?.(args.out) ?? args.units;
  assertValidUnits(work, "unit");

  const evidence = config.evidence?.(args.out);
  if (evidence) assertValidUnits(evidence, "artifact");

  const receipt: Receipt = {
    v: RECEIPT_VERSION,
    kind: "delivery",
    jobId: args.jobId,
    capability: config.capability,
    // The answer, committed to. Empty here would mean the receipt promises nothing about
    // what was delivered while looking complete.
    resultHash: hashCanonical(args.out),
    sources: [],
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    // A generic adopter has no plan in the browser-job sense. The verifier compares plan
    // against work to show absorbed variance; with nothing estimated there is nothing to
    // absorb, and zeroes say that more honestly than invented numbers would.
    plan: { steps: 0, pages: 0, estimatedMs: 0 },
    work,
    price: {
      unit: args.asset === "0.0.0" ? "tinybar" : args.asset,
      quoted: args.amount,
      charged: args.charged,
    },
    payment: {
      network: args.network,
      scheme: "exact",
      asset: args.asset,
      payer: args.payer,
      payTo: args.payTo,
    },
    ...(evidence ? { evidence } : {}),
    status: args.status,
  };

  assertFitsOneChunk(receipt);
  return signReceipt(receipt, args.identity);
}
