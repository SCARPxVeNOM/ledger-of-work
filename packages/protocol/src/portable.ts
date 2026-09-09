/**
 * Everything in the trust core that runs anywhere.
 *
 * The split is deliberate and enforced rather than conventional: this entry point
 * excludes `hash.ts`, which is the only module needing a platform primitive. A browser
 * build imports from here and supplies its own Web Crypto digest, and because the
 * *encoding* the hash is taken over lives on this side of the line, the two runtimes
 * cannot drift apart in the way that would actually matter.
 *
 * If something added here ever pulls in `node:`, the browser bundle fails loudly at
 * build time — which is the point of having the boundary be a file rather than a habit.
 */
export {
  HBAR,
  HBAR_ASSET,
  formatAssetAmount,
  isHbar,
  tinybarToAssetUnits,
  type AssetSpec,
} from "./assets.js";
export { canonical, canonicalByteLength } from "./canonical.js";
export {
  TINYBAR_PER_HBAR,
  consensusTimestampToMillis,
  hbarToTinybar,
  parseConsensusTimestamp,
  tinybarToHbar,
  toRestTxId,
  toSdkTxId,
} from "./hedera.js";
export { price, priceTinybars, type PriceBreakdown, type PricedWork } from "./price.js";
export {
  HCS_CHUNK_BYTES,
  RECEIPT_VERSION,
  SUPPORTED_RECEIPT_VERSIONS,
  type CheckResult,
  type EvidenceRef,
  type JobStatus,
  type PaymentRef,
  type PriceBook,
  type Receipt,
  type ReceiptKind,
  type StepLog,
} from "./types.js";
export {
  fitReceipt,
  fitsOneChunk,
  verifyReceipt,
  type MirrorTopicMessage,
  type MirrorTransaction,
  type VerifyInput,
  type VerifyOutput,
} from "./verify.js";
