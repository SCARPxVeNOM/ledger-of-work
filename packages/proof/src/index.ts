import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashCanonical } from "@low/protocol";
import {
  checkCoverage,
  matchedValues,
  proofBytes,
  reviveBytes,
  witnessedRequest,
  type CoverageResult,
  type RetrievalProof,
  type RetrievalRef,
} from "./portable.js";

export {
  checkCoverage,
  matchedValues,
  proofBytes,
  reviveBytes,
  witnessedRequest,
  type CoverageInput,
  type CoverageResult,
  type RetrievalProof,
  type RetrievalRef,
} from "./portable.js";

/**
 * Retrieval proofs: evidence that a response genuinely came from the source.
 *
 * ── What this adds over the evidence bundle ─────────────────────────────────────
 * A receipt hashes the result, the page, and a screenshot. All three are things the
 * seller produced, so a seller willing to fabricate can fabricate all three coherently
 * and every check still passes. The evidence bundle raises the cost of lying; it does not
 * make lying impossible.
 *
 * zkTLS does. An independent attestor opens the TLS session alongside us and signs that
 * a response from that host contained a given string. We never hold the power to forge
 * that signature, because we do not hold the attestor's key.
 *
 * ── What it is not ──────────────────────────────────────────────────────────────
 * A witness, not mathematics. The claim becomes "an independent attestor observed this
 * TLS session", which is strictly weaker than "this is unforgeable" — collude with the
 * attestor, or compromise it, and the proof is worth what any signature from a
 * compromised key is worth. It is a large improvement on "trust the seller" and it is
 * not an absolute.
 *
 * ── Measured cost ───────────────────────────────────────────────────────────────
 * Proving a 263KB public page took 2.1s, because with no credentials to hide the whole
 * transcript can be revealed and no ZK proving is needed at all. The same call against a
 * 40KB response behind a bearer token took 28s, 25s of which was generating eight ZK
 * proofs to keep the token secret. Cost tracks what has to stay hidden, not response
 * size — which is why this is enabled for public sources and left off elsewhere.
 */

/** Public attestor. Independent of us, which is the entire value of the signature. */
export const DEFAULT_ATTESTOR = "wss://attestor.reclaimprotocol.org:444/ws";

/** Where fetched circuits are cached, so the multi-megabyte download happens once. */
const ZK_CACHE_DIR = ".data/zk-resources";

export interface ProveOptions {
  url: string;
  method?: "GET" | "POST";
  /** Headers the attestor may see. Never put a credential here. */
  headers?: Record<string, string>;
  body?: string;
  /**
   * Headers the attestor must not see. The SDK refuses to build a request with no secret
   * parameters at all, so a public source still needs one — an inert one will do.
   */
  secretHeaders?: Record<string, string>;
  cookieStr?: string;
  /** The substring the attestor must confirm is present. Make this the answer. */
  mustContain: string;
  /** Identifies the proof's owner. An EVM-style key, unrelated to the Hedera keys. */
  ownerPrivateKey: string;
  attestorUrl?: string;
}

/**
 * Register the TLS crypto implementation.
 *
 * `@reclaimprotocol/tls` exports `crypto` as an empty object and expects the host to fill
 * it via `setCryptoImplementation`. attestor-core imports that same object and calls
 * `crypto.randomBytes` on it, so skipping this step fails every claim instantly with
 * "crypto.randomBytes is not a function" — which reads like a Node/WebCrypto mismatch and
 * is not one. Shimming `globalThis.crypto` cannot fix it, because the binding being called
 * is an imported module object rather than the global.
 */
async function installTlsCrypto(): Promise<void> {
  const tls = await import("@reclaimprotocol/tls");
  if (typeof (tls.crypto as { randomBytes?: unknown }).randomBytes === "function") return;
  const { webcryptoCrypto } = await import("@reclaimprotocol/tls/webcrypto");
  tls.setCryptoImplementation(webcryptoCrypto);
}

/**
 * Build the ZK operators with a fetcher that caches to disk.
 *
 * The SDK's own resolution does not work from an installed package on Node: its local
 * mode reads a `resources/` directory that only exists in the source repo, and its remote
 * mode falls back to the browser build's relative `/browser-rpc/resources`, which is not
 * a URL Node can fetch. Supplying the fetcher sidesteps both. Files come from the commit
 * the package itself pins.
 */
// biome-ignore lint/suspicious/noExplicitAny: the SDK's operator type is not exported
async function makeZkOperators(): Promise<Record<string, any>> {
  const { makeRemoteFileFetch } = await import("@reclaimprotocol/zk-symmetric-crypto");
  const { makeSnarkJsZKOperator } = await import("@reclaimprotocol/zk-symmetric-crypto/snarkjs");

  const remote = makeRemoteFileFetch();
  type Engine = Parameters<typeof remote.fetch>[0];
  const fetcher = {
    async fetch(engine: Engine, filename: string): Promise<Uint8Array> {
      const path = `${ZK_CACHE_DIR}/${engine}/${filename}`;
      if (existsSync(path)) return new Uint8Array(readFileSync(path));
      const bytes = await remote.fetch(engine, filename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      return bytes;
    },
  };

  // The server picks the cipher, so make all three available rather than guessing.
  // biome-ignore lint/suspicious/noExplicitAny: as above
  const operators: Record<string, any> = {};
  for (const algorithm of ["chacha20", "aes-128-ctr", "aes-256-ctr"] as const) {
    operators[algorithm] = makeSnarkJsZKOperator({ algorithm, fetcher });
  }
  return operators;
}

/**
 * Ask an attestor to witness one response.
 *
 * Returns null rather than throwing when the attestor cannot be reached or refuses. A
 * job that produced a real answer should not fail because a third party was unavailable
 * — the receipt then simply carries no retrieval proof, and the verifier reports that as
 * unproven rather than as fine.
 */
export async function proveRetrieval(options: ProveOptions): Promise<RetrievalProof | null> {
  try {
    await installTlsCrypto();
    const zkOperators = await makeZkOperators();
    const { createClaimOnAttestor } = await import("@reclaimprotocol/attestor-core");

    const result = await createClaimOnAttestor({
      name: "http",
      params: {
        url: options.url,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        ...(options.body ? { body: options.body } : {}),
        responseMatches: [{ type: "contains", value: options.mustContain }],
      },
      secretParams: {
        ...(options.cookieStr ? { cookieStr: options.cookieStr } : {}),
        headers: options.secretHeaders ?? { "accept-language": "en-US,en;q=0.9" },
      },
      ownerPrivateKey: options.ownerPrivateKey,
      zkOperators,
      client: { url: options.attestorUrl ?? DEFAULT_ATTESTOR },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's params type is structural
    } as any);

    if (!result || (result as { error?: unknown }).error) return null;
    return result as unknown as RetrievalProof;
  } catch {
    // Deliberately swallowed: see the doc comment. The absence of a proof is recorded
    // honestly downstream, which is safer than a job failing for a reason the buyer
    // cannot act on.
    return null;
  }
}

/**
 * What goes in the receipt: the commitment, and who vouched.
 *
 * Nothing else. The receipt has 1024 bytes for the whole record and a proof is a few
 * thousand, so this is a pointer with a witness attached — everything a checker needs
 * beyond it comes from the proof itself, which they must have anyway.
 */
export function summarise(proof: RetrievalProof): RetrievalRef {
  return { proofHash: hashProof(proof) };
}

/** `sha256:<hex>` over the canonical encoding of the whole proof. */
export function hashProof(proof: RetrievalProof): string {
  return hashCanonical(JSON.parse(proofBytes(proof)));
}

export interface CheckProofInput {
  proof: RetrievalProof;
  /** What the receipt committed to, so a swapped proof is caught. */
  ref: RetrievalRef;
  /** The URL the receipt says was visited. */
  expectedUrl: string;
  /** The answer delivered to the buyer. */
  answer: string;
}

export interface ProofCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * Check a proof three ways, because any one of them alone is satisfiable by a liar.
 *
 * A valid signature over a claim about a different page proves nothing about this job. A
 * proof matching this job's URL but bearing a forged signature proves nothing at all. And
 * a proof that is both valid and on-topic still proves nothing if it is not the proof the
 * receipt committed to, because it could have been swapped in afterwards.
 */
export async function checkRetrievalProof(input: CheckProofInput): Promise<ProofCheck[]> {
  const checks: ProofCheck[] = [];

  const computed = hashProof(input.proof);
  checks.push({
    id: "proof-hash",
    label: "Retrieval proof is the one the receipt committed to",
    ok: computed === input.ref.proofHash,
    detail:
      computed === input.ref.proofHash
        ? computed
        : `computed ${computed}, receipt claims ${input.ref.proofHash}`,
  });

  let signatureOk = false;
  let signatureDetail: string;
  try {
    await installTlsCrypto();
    const { assertValidClaimSignatures } = await import("@reclaimprotocol/attestor-core");
    // Revive first. Without it this throws while encoding the claim, which looks
    // identical to an invalid signature and would make every proof "fail" equally.
    // biome-ignore lint/suspicious/noExplicitAny: the SDK's proof type is structural
    await assertValidClaimSignatures(reviveBytes(input.proof) as any);
    signatureOk = true;
    signatureDetail = `signed by attestor ${input.proof.signatures.attestorAddress}`;
  } catch (err) {
    signatureDetail = `rejected: ${(err as Error).message}`;
  }
  checks.push({
    id: "proof-signature",
    label: "An independent attestor signed this claim",
    ok: signatureOk,
    detail: signatureDetail,
  });

  const coverage: CoverageResult = checkCoverage({
    proof: input.proof,
    expectedUrl: input.expectedUrl,
    answer: input.answer,
  });
  checks.push({
    id: "proof-coverage",
    label: "The witnessed response covers the answer sold",
    ok: coverage.ok,
    detail: coverage.detail,
  });

  return checks;
}
