import { canonical, type RetrievalRef } from "@low/protocol/portable";

// Re-exported so callers of this package do not have to import the shape from two places.
// Defining a second copy here is exactly how the receipt and the thing that fills it drift
// apart, and the drift would only show up as a receipt nobody can verify.
export type { RetrievalRef };

/**
 * The half of retrieval proofs that runs anywhere.
 *
 * Split from `index.ts` for the same reason `@low/protocol/portable` is split from
 * `hash.ts`: the attestor SDK pulls in a TLS stack, a websocket client, and a snarkjs
 * prover, none of which belong in a static verifier page. What a *checker* needs is the
 * shape of the artifact and the questions to ask of it, and all of that is here.
 *
 * Signature verification itself needs the SDK and lives in `index.ts`.
 */

/**
 * A retrieval proof as it is handed to the buyer.
 *
 * Deliberately structural rather than an import of the SDK's type: this is the shape we
 * promise, and it must stay readable by a verifier that has no attestor-core installed.
 */
export interface RetrievalProof {
  claim: {
    provider: string;
    /** JSON string. Holds the url, method, body, public headers, and responseMatches. */
    parameters: string;
    owner: string;
    timestampS: number;
    context: string;
    identifier: string;
    epoch: number;
  };
  signatures: {
    attestorAddress: string;
    /** Bytes. Survives JSON as an index-keyed object — see `reviveBytes`. */
    claimSignature: unknown;
    resultSignature?: unknown;
  };
  request?: unknown;
}

/**
 * Put JSON-mangled byte arrays back into `Uint8Array`s.
 *
 * A proof holds five of them — signatures and TLS IVs — and JSON has no byte array, so
 * each survives a round trip as an object keyed by byte index. This matters far more than
 * it looks: a proof loaded from a file and not revived fails signature verification while
 * *encoding* the claim, before the signature is ever examined. That failure is
 * indistinguishable from "the signature is invalid", so a tamper test written against an
 * unrevived proof passes on every mutation including no mutation at all. It looks like a
 * working check and is testing nothing.
 */
export function reviveBytes<T>(node: T): T {
  if (node === null || typeof node !== "object") return node;
  if (node instanceof Uint8Array) return node;
  if (Array.isArray(node)) return node.map(reviveBytes) as unknown as T;

  const keys = Object.keys(node as object);
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    const rec = node as Record<string, number>;
    return Uint8Array.from(keys.map((k) => rec[k] as number)) as unknown as T;
  }
  return Object.fromEntries(
    keys.map((k) => [k, reviveBytes((node as Record<string, unknown>)[k])]),
  ) as T;
}

/** The bytes a proof's hash is taken over. Canonical, so the hash is stable across hosts. */
export function proofBytes(proof: RetrievalProof): string {
  return canonical(proof);
}

/** What the attestor was asked to confirm was present in the response. */
export function matchedValues(proof: RetrievalProof): string[] {
  try {
    const params = JSON.parse(proof.claim.parameters) as {
      responseMatches?: Array<{ value?: string }>;
    };
    return (params.responseMatches ?? []).map((m) => m.value ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** The request the attestor witnessed, as the claim records it. */
export function witnessedRequest(proof: RetrievalProof): { url: string; method: string } | null {
  try {
    const params = JSON.parse(proof.claim.parameters) as { url?: string; method?: string };
    if (!params.url) return null;
    return { url: params.url, method: params.method ?? "GET" };
  } catch {
    return null;
  }
}

export interface CoverageInput {
  proof: RetrievalProof;
  /** The URL the receipt says was visited. */
  expectedUrl: string;
  /** The answer delivered to the buyer, as text the response would have contained. */
  answer: string;
}

export interface CoverageResult {
  ok: boolean;
  detail: string;
}

/**
 * Does this proof actually cover the answer that was sold?
 *
 * The question a valid signature does *not* answer. An attestor will happily witness that
 * some response from some host contained the string `"start"` — which is true, signed,
 * and worth nothing. Three things have to line up before a proof supports the delivered
 * result:
 *
 *   1. the witnessed request went to the host the receipt names,
 *   2. the attestor confirmed a substring was present, and
 *   3. that substring appears in the answer the buyer was given.
 *
 * Without (3) the proof and the result are two unrelated documents stapled together, and
 * a seller could witness any page while returning anything at all.
 */
export function checkCoverage(input: CoverageInput): CoverageResult {
  const witnessed = witnessedRequest(input.proof);
  if (!witnessed) return { ok: false, detail: "the proof records no request" };

  let witnessedHost: string;
  let expectedHost: string;
  try {
    witnessedHost = new URL(witnessed.url).host;
    expectedHost = new URL(input.expectedUrl).host;
  } catch {
    return { ok: false, detail: `cannot compare ${witnessed.url} with ${input.expectedUrl}` };
  }

  if (witnessedHost !== expectedHost) {
    return {
      ok: false,
      detail: `the proof witnesses ${witnessedHost}, but the receipt claims ${expectedHost}`,
    };
  }

  const matches = matchedValues(input.proof);
  if (matches.length === 0) {
    return { ok: false, detail: "the proof asserts nothing about the response body" };
  }

  // Compare on collapsed whitespace: the answer is extracted from rendered text while the
  // match is taken from the raw response, and the two differ in whitespace alone.
  const answer = input.answer.replace(/\s+/g, " ").trim();
  const uncovered = matches.filter((m) => !answer.includes(m.replace(/\s+/g, " ").trim()));
  if (uncovered.length > 0) {
    return {
      ok: false,
      detail: `the proof witnesses ${JSON.stringify(uncovered[0])}, which is not in the delivered answer`,
    };
  }

  return {
    ok: true,
    detail: `${witnessedHost} confirmed to have returned ${JSON.stringify(matches[0])}, which is in the answer`,
  };
}
