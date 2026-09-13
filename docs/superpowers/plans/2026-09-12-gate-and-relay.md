# Gate and Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a service that is not this one take x402 payment on Hedera and emit a receipt its buyers can verify, by installing a middleware and posting signed receipts to a relay that pays the fees.

**Architecture:** `@low/gate` runs in the adopter's process, holds their key, and does four things: price, settle, commit, sign. `apps/relay` accepts a signed receipt, checks the signature against the directory, and submits it to the adopter's own topic on our HBAR. The buyer receives the signed receipt in the HTTP response, before it reaches HCS, so a relay outage delays permanence rather than destroying evidence.

**Tech Stack:** TypeScript, Node 22, vitest, `@hiero-ledger/sdk`, node:http.

## Global Constraints

- **Everything from Plan 1 exists**: `signReceipt`, `signingBytes`, `verifySignature`, `assertValidUnits`, `assertFitsOneChunk`, `readEvidence`, `resolveSigner`, receipt v4.
- **57 receipts on topic `0.0.10413059` must keep verifying.** Check with `pnpm verify --topic 0.0.10413059 --seq 18 …` after any change to protocol or receipts.
- **A signed receipt is never modified after signing.** See Task 1 — this is not a style rule, it is the one way this design fails silently.
- **1024 bytes** remains the hard limit.
- **No network in tests.**
- **Commit style:** no Claude attribution.
- Single test: `npx vitest run <path> -t "<name>"`. Everything: `npx vitest run`.

---

### Task 1: Never trim a signed receipt

**Files:**
- Modify: `packages/receipts/src/publisher.ts`
- Test: `packages/receipts/test/publisher-signed.test.ts`

**Interfaces:**
- Consumes: `fitReceipt`, `fitsOneChunk` from `@low/protocol`.
- Produces: `ReceiptPublisher.publish` throws `SignedReceiptTooLarge` rather than trimming a receipt that carries `sig`.

`publish` currently calls `fitReceipt`, which drops source URLs until the receipt fits. That is right for an unsigned receipt — losing a source beats failing a job the buyer paid for — and catastrophic for a signed one, because the signature covers the untrimmed bytes. The receipt would publish and then fail verification for everyone, quietly, only on the oversized ones.

- [ ] **Step 1: Write the failing test**

```ts
// packages/receipts/test/publisher-signed.test.ts
import { describe, expect, it } from "vitest";
import { fitReceipt, signingBytes } from "@low/protocol";
import { makeReceipt } from "./fixtures.js";

describe("trimming and signatures", () => {
  const oversized = () => ({
    ...makeReceipt(),
    sources: Array.from({ length: 40 }, (_, i) => `https://example.com/a-fairly-long-path/${i}`),
    sig: { alg: "ed25519" as const, by: "uaid:aid:abc", sig: "zzz" },
  });

  it("changes the bytes a signature covers, which is why it must not happen after signing", () => {
    const receipt = oversized();
    const { receipt: trimmed, droppedSources } = fitReceipt(receipt);

    expect(droppedSources).toBeGreaterThan(0);
    // The proof of the hazard: same receipt, different signing input.
    expect(signingBytes(trimmed)).not.toBe(signingBytes(receipt));
  });
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `npx vitest run packages/receipts/test/publisher-signed.test.ts`
Expected: PASS. This test documents the hazard rather than driving the fix; the fix is driven by the next test.

- [ ] **Step 3: Write the failing test for the guard**

```ts
// append to packages/receipts/test/publisher-signed.test.ts
import { assertNotTrimmedAfterSigning, SignedReceiptTooLarge } from "../src/publisher.js";

describe("publishing a signed receipt", () => {
  const signed = (over = {}) => ({
    ...makeReceipt(),
    sig: { alg: "ed25519" as const, by: "uaid:aid:abc", sig: "zzz" },
    ...over,
  });

  it("refuses an oversized signed receipt rather than trimming it", () => {
    const receipt = signed({
      sources: Array.from({ length: 40 }, (_, i) => `https://example.com/a-fairly-long-path/${i}`),
    });

    expect(() => assertNotTrimmedAfterSigning(receipt)).toThrow(SignedReceiptTooLarge);
  });

  it("explains that the signer must shrink it before signing", () => {
    const receipt = signed({
      sources: Array.from({ length: 40 }, (_, i) => `https://example.com/a-fairly-long-path/${i}`),
    });

    expect(() => assertNotTrimmedAfterSigning(receipt)).toThrow(/before signing/);
  });

  it("says nothing about a signed receipt that already fits", () => {
    expect(() => assertNotTrimmedAfterSigning(signed())).not.toThrow();
  });

  it("says nothing about an unsigned receipt, which may still be trimmed", () => {
    const unsigned = {
      ...makeReceipt(),
      sources: Array.from({ length: 40 }, (_, i) => `https://example.com/a-fairly-long-path/${i}`),
    };

    expect(() => assertNotTrimmedAfterSigning(unsigned)).not.toThrow();
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run packages/receipts/test/publisher-signed.test.ts`
Expected: FAIL — `assertNotTrimmedAfterSigning is not exported`

- [ ] **Step 5: Implement**

In `packages/receipts/src/publisher.ts`:

```ts
export class SignedReceiptTooLarge extends Error {
  constructor(jobId: string) {
    super(
      `receipt for job ${jobId} is signed and over one HCS chunk. Trimming it would ` +
        `change the bytes the signature covers, so it would publish and then fail to ` +
        `verify for everyone. Shrink it before signing — drop sources or artifacts.`,
    );
    this.name = "SignedReceiptTooLarge";
  }
}

/**
 * A signed receipt is published exactly as signed, or not at all.
 *
 * `fitReceipt` drops source URLs until a receipt fits, which is the right trade for an
 * unsigned one: losing a source beats failing a job the buyer has already paid for. For a
 * signed receipt it is the opposite, and quietly so — the signature covers the untrimmed
 * bytes, so a trimmed receipt lands on the topic and fails verification for everyone who
 * reads it, on the oversized receipts only, which are the rare ones nobody tests.
 */
export function assertNotTrimmedAfterSigning(receipt: Receipt): void {
  if (!receipt.sig) return;
  if (fitsOneChunk(receipt)) return;
  throw new SignedReceiptTooLarge(receipt.jobId);
}
```

Call it as the first line of `publish`, before `fitReceipt`.

- [ ] **Step 6: Run tests and the on-chain check**

Run: `npx vitest run` — expected PASS
Run: `pnpm verify --topic 0.0.10413059 --seq 18 --result ./samples/result-proof.json --capability oracle.capture_claim --submitter 0.0.10410493 --artifacts ./samples/result-proof.page.html,./samples/result-proof.screenshot.png --proof ./samples/result-proof.proof.json`
Expected: `VERIFIED — 15/15`

- [ ] **Step 7: Commit**

```bash
git add packages/receipts/src/publisher.ts packages/receipts/test/publisher-signed.test.ts
git commit -m "Never trim a signed receipt"
```

---

### Task 2: `@low/gate` — price, charge, and refuse to charge

**Files:**
- Create: `packages/gate/package.json`, `packages/gate/tsconfig.json`, `packages/gate/src/index.ts`, `packages/gate/src/gate.ts`
- Test: `packages/gate/test/gate.test.ts`

**Interfaces:**
- Consumes: `price`, `assertValidUnits`, `Receipt`, `PriceBook` from `@low/protocol`.
- Produces:
```ts
export interface GateConfig<Out> {
  book: PriceBook;
  price: (req: GateRequest) => Record<string, number>;
  work?: (out: Out) => Record<string, number>;
  evidence?: (out: Out) => Record<string, string>;
  delivered?: (out: Out) => { ok: true } | { ok: false; why: string };
  capability: string;
}
export interface GateRequest { body: unknown }
export function quoteFor<Out>(config: GateConfig<Out>, req: GateRequest): { units: Record<string, number>; amount: string };
export function decideSettlement<Out>(config: GateConfig<Out>, out: Out): { settle: true } | { settle: false; why: string };
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/gate/test/gate.test.ts
import { describe, expect, it } from "vitest";
import { decideSettlement, quoteFor } from "../src/gate.js";

const BOOK = {
  base: "1000",
  perStep: "0",
  perPage: "0",
  perSecond: "0",
  ceiling: "1000000",
  per: { tokens: "5" },
};

const config = {
  capability: "text.summarise",
  book: BOOK,
  price: (req: { body: unknown }) => ({ tokens: (req.body as { tokens: number }).tokens }),
  delivered: (out: { text: string }) =>
    out.text.length > 0
      ? ({ ok: true } as const)
      : ({ ok: false, why: "the model returned nothing. Nothing was charged." } as const),
};

describe("quoting before the work", () => {
  it("prices from the published book, not from anything the request says", () => {
    // base 1000 + 200 tokens at 5 = 2000
    expect(quoteFor(config, { body: { tokens: 200 } }).amount).toBe("2000");
  });

  it("reports the units it priced, so the receipt can record them", () => {
    expect(quoteFor(config, { body: { tokens: 200 } }).units).toEqual({ tokens: 200 });
  });

  it("refuses units the receipt schema could not carry", () => {
    const tooMany = {
      ...config,
      price: () => ({ a: 1, b: 2, c: 3, d: 4, e: 5 }),
    };

    expect(() => quoteFor(tooMany, { body: {} })).toThrow(/at most 4/);
  });

  it("refuses a unit the book does not price", () => {
    const unpriced = { ...config, price: () => ({ widgets: 3 }) };

    expect(() => quoteFor(unpriced, { body: {} })).toThrow(/widgets/);
  });
});

describe("deciding whether to charge", () => {
  it("settles when the handler delivered something", () => {
    expect(decideSettlement(config, { text: "a summary" })).toEqual({ settle: true });
  });

  it("does not settle when it delivered nothing, and says why", () => {
    const decision = decideSettlement(config, { text: "" });

    expect(decision.settle).toBe(false);
    if (decision.settle) return;
    expect(decision.why).toMatch(/Nothing was charged/);
  });

  it("settles by default when the adopter declares no opinion", () => {
    // For a search, finding nothing is an answer. Only the adopter knows which they are.
    const { delivered: _none, ...noOpinion } = config;

    expect(decideSettlement(noOpinion, { text: "" })).toEqual({ settle: true });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/gate` — expected FAIL, module not found

- [ ] **Step 3: Create the package**

`packages/gate/package.json`:
```json
{
  "name": "@low/gate",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Take x402 payment and emit a signed receipt, from inside someone else's service.",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": { "@low/protocol": "workspace:*" }
}
```

`packages/gate/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "references": [{ "path": "../protocol" }]
}
```

- [ ] **Step 4: Implement**

```ts
// packages/gate/src/gate.ts
import { assertValidUnits, price, type PriceBook } from "@low/protocol";

/** What the gate is given about an incoming request. Deliberately tiny. */
export interface GateRequest {
  body: unknown;
}

export interface GateConfig<Out> {
  /** Capability id, recorded on the receipt so a buyer can price-check it. */
  capability: string;
  /** Published before the job runs, and checked by the verifier afterwards. */
  book: PriceBook;
  /** What this request will cost, in named units, decided before the work happens. */
  price: (req: GateRequest) => Record<string, number>;
  /** What the work actually consumed. Defaults to what was quoted. */
  work?: (out: Out) => Record<string, number>;
  /** Named artifacts to commit to. The values are hashed; they are never sent anywhere. */
  evidence?: (out: Out) => Record<string, string>;
  /**
   * Did this deliver what was sold?
   *
   * Absent means yes, which is right for a search: finding nothing is an answer, and
   * making it free would let a buyer take work for the price of a bad query. A capture
   * is the opposite and should say so.
   */
  delivered?: (out: Out) => { ok: true } | { ok: false; why: string };
}

/**
 * Price a request before doing any of the work.
 *
 * Validating the units here rather than at receipt-building time is deliberate: a unit
 * set the receipt schema cannot carry is a bug in the adopter's config, and the moment to
 * say so is the first request, not the first request that happens to be oversized.
 */
export function quoteFor<Out>(
  config: GateConfig<Out>,
  req: GateRequest,
): { units: Record<string, number>; amount: string } {
  const units = config.price(req);
  assertValidUnits(units, "unit");
  return { units, amount: price(units, config.book).total.toString() };
}

/** Whether the buyer should be charged, now that the work is done. */
export function decideSettlement<Out>(
  config: GateConfig<Out>,
  out: Out,
): { settle: true } | { settle: false; why: string } {
  const verdict = config.delivered?.(out);
  if (!verdict || verdict.ok) return { settle: true };
  return { settle: false, why: verdict.why };
}
```

```ts
// packages/gate/src/index.ts
export { decideSettlement, quoteFor, type GateConfig, type GateRequest } from "./gate.js";
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/gate` — expected PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add packages/gate
git commit -m "A gate that prices before the work and refuses to charge for nothing"
```

---

### Task 3: `@low/gate` — build and sign the receipt

**Files:**
- Create: `packages/gate/src/receipt.ts`
- Modify: `packages/gate/src/index.ts`
- Test: `packages/gate/test/receipt.test.ts`

**Interfaces:**
- Consumes: `quoteFor`, `decideSettlement` from Task 2; `signReceipt`, `assertFitsOneChunk`, `RECEIPT_VERSION` from `@low/protocol`.
- Produces: `buildReceipt<Out>(config, args): Receipt` where `args` is `{ jobId, units, work, out, amount, charged, payer, payTo, network, asset, startedAt, finishedAt, status, identity }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gate/test/receipt.test.ts
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { hashCanonical, verifySignature } from "@low/protocol";
import { buildReceipt } from "../src/receipt.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signer = {
  alg: "ed25519" as const,
  by: "uaid:aid:abc",
  sign: (bytes: string) =>
    nodeSign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64url"),
};
const verify = (bytes: string, sig: string) =>
  nodeVerify(null, Buffer.from(bytes, "utf8"), publicKey, Buffer.from(sig, "base64url"));

const config = {
  capability: "text.summarise",
  book: { base: "1000", perStep: "0", perPage: "0", perSecond: "0", ceiling: "1000000", per: { tokens: "5" } },
  price: () => ({ tokens: 200 }),
  evidence: (out: { text: string }) => ({ output: hashCanonical(out.text) }),
};

const args = {
  jobId: "job-1",
  units: { tokens: 200 },
  out: { text: "a summary" },
  amount: "2000",
  charged: "2000",
  payer: "0.0.123",
  payTo: "0.0.456",
  network: "hedera:testnet",
  asset: "0.0.0",
  startedAt: "2026-09-12T00:00:00.000Z",
  finishedAt: "2026-09-12T00:00:01.000Z",
  status: "ok" as const,
  identity: signer,
};

describe("building a receipt from what happened", () => {
  it("signs it, and the signature verifies", () => {
    expect(verifySignature(buildReceipt(config, args), verify)).toBe(true);
  });

  it("records the units that were metered", () => {
    expect(buildReceipt(config, args).work).toEqual({ tokens: 200 });
  });

  it("commits to the declared artifacts by hash, never by value", () => {
    const receipt = buildReceipt(config, args);

    expect(receipt.evidence?.output).toBe(hashCanonical("a summary"));
    // The whole point: the text itself is nowhere in the receipt.
    expect(JSON.stringify(receipt)).not.toContain("a summary");
  });

  it("is written at the current schema version", () => {
    expect(buildReceipt(config, args).v).toBe(4);
  });

  it("commits to the answer itself, so the buyer's copy can be checked", () => {
    expect(buildReceipt(config, args).resultHash).toBe(hashCanonical(args.out));
  });

  it("refuses to sign something that could not be published", () => {
    // Signing first and discovering the size later is the failure mode Task 1 guards
    // against on the way out; this stops it being created in the first place.
    const fat = { ...config, evidence: () => Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`art${i}`, `sha256:${"a".repeat(2000)}`]),
    ) };

    expect(() => buildReceipt(fat, args)).toThrow(/1024/);
  });

  it("records a job that delivered nothing as failed and charged zero", () => {
    const receipt = buildReceipt(config, { ...args, charged: "0", status: "failed" });

    expect(receipt.status).toBe("failed");
    expect(receipt.price.charged).toBe("0");
    expect(receipt.price.quoted).toBe("2000");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/gate/test/receipt.test.ts` — expected FAIL, module not found

- [ ] **Step 3: Implement**

```ts
// packages/gate/src/receipt.ts
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
  /** What was quoted, in named units. */
  units: Record<string, number>;
  /** What the handler returned. Hashed, never transmitted. */
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
  identity: { alg: "ed25519" | "ecdsa-secp256k1"; by: string; sign: (bytes: string) => string };
}

/**
 * Turn what happened into a signed receipt.
 *
 * Size is checked *before* signing, not after. A receipt that is signed and then found to
 * be too large has only bad options: trimming it invalidates the signature, and not
 * publishing it leaves a paid job with no record. Checking first means the failure lands
 * on the adopter's own config, which is where it can be fixed.
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
    // The answer itself, committed to. Empty here would mean the receipt promises nothing
    // about what was delivered, and the verifier's integrity check would compare a real
    // hash against the empty string on every job.
    resultHash: hashCanonical(args.out),
    sources: [],
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    plan: { steps: 0, pages: 0, estimatedMs: 0 },
    work,
    price: { unit: args.asset === "0.0.0" ? "tinybar" : args.asset, quoted: args.amount, charged: args.charged },
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/gate` — expected PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gate
git commit -m "Build the receipt, check it fits, then sign it"
```

---

### Task 4: `apps/relay` — submit what we cannot forge

**Files:**
- Create: `apps/relay/package.json`, `apps/relay/tsconfig.json`, `apps/relay/src/relay.ts`, `apps/relay/src/main.ts`
- Test: `apps/relay/test/relay.test.ts`

**Interfaces:**
- Consumes: `verifySignature`, `assertFitsOneChunk` from `@low/protocol`; `resolveSigner` from `@low/receipts`.
- Produces: `class Relay { accept(receipt: Receipt): Promise<{ ok: true; topic: string } | { ok: false; error: string }> }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/relay/test/relay.test.ts
import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { signReceipt } from "@low/protocol";
import { Relay } from "../src/relay.js";

/** A minimal valid receipt, built here rather than imported across a package boundary. */
const makeReceipt = () => ({
  v: 4 as const,
  kind: "delivery" as const,
  jobId: "job-1",
  capability: "text.wordcount",
  resultHash: "sha256:aa",
  sources: [],
  startedAt: "2026-09-12T00:00:00.000Z",
  finishedAt: "2026-09-12T00:00:01.000Z",
  plan: { steps: 0, pages: 0, estimatedMs: 0 },
  work: { tokens: 5 },
  price: { unit: "tinybar", quoted: "1025", charged: "1025" },
  payment: {
    network: "hedera:testnet",
    scheme: "exact" as const,
    asset: "0.0.0",
    payer: "0.0.1",
    payTo: "0.0.2",
  },
  status: "ok" as const,
});

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const IDENTITY = "uaid:aid:abc";
const signed = () =>
  signReceipt(makeReceipt(), {
    alg: "ed25519",
    by: IDENTITY,
    sign: (b) => nodeSign(null, Buffer.from(b, "utf8"), privateKey).toString("base64url"),
  });

function relay(over: Partial<ConstructorParameters<typeof Relay>[0]> = {}) {
  const submit = vi.fn(async () => ({ topicId: "0.0.777", sequenceNumber: 1 }));
  const r = new Relay({
    submit,
    resolve: async () => ({ topic: "0.0.777", publicKey: "x", book: {} as never }),
    verify: (bytes, sig) =>
      nodeVerify(null, Buffer.from(bytes, "utf8"), publicKey, Buffer.from(sig, "base64url")),
    quotaPerIdentity: 10,
    ...over,
  });
  return { relay: r, submit };
}

describe("accepting a receipt", () => {
  it("submits one that is signed by a listed identity", async () => {
    const { relay: r, submit } = relay();

    expect(await r.accept(signed())).toEqual({ ok: true, topic: "0.0.777" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("refuses an unsigned receipt", async () => {
    const { relay: r, submit } = relay();
    const out = await r.accept(makeReceipt());

    expect(out).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a receipt whose signature does not verify", async () => {
    // We pay the fee, so we check before spending. The buyer checks again afterwards.
    const { relay: r, submit } = relay({ verify: () => false });

    expect(await r.accept(signed())).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses an identity nobody listed", async () => {
    const { relay: r, submit } = relay({ resolve: async () => null });

    expect(await r.accept(signed())).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits a repeated jobId only once", async () => {
    // A duplicate costs us HBAR and adds nothing. This is a cost defence, not a
    // correctness one — the receipt would be identical either way.
    const { relay: r, submit } = relay();
    const receipt = signed();

    await r.accept(receipt);
    const second = await r.accept(receipt);

    expect(second).toMatchObject({ ok: false });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("stops an identity that exceeds its quota", async () => {
    // Every submission spends our HBAR, so an adopter — or whoever holds their key — can
    // otherwise drain the relay.
    const { relay: r, submit } = relay({ quotaPerIdentity: 2 });

    for (let i = 0; i < 4; i++) {
      await r.accept({ ...signed(), jobId: `job-${i}` });
    }

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("refuses a receipt too large to publish, rather than trimming it", async () => {
    const { relay: r, submit } = relay();
    const fat = {
      ...signed(),
      sources: Array.from({ length: 40 }, (_, i) => `https://example.com/a-long-path/${i}`),
    };

    expect(await r.accept(fat)).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/relay` — expected FAIL, module not found

- [ ] **Step 3: Implement**

```ts
// apps/relay/src/relay.ts
import { fitsOneChunk, verifySignature, type Receipt } from "@low/protocol";
import type { PriceBook } from "@low/protocol";

export interface RelayDeps {
  /** Publish to the adopter's topic, paying the fee. */
  submit: (topic: string, receipt: Receipt) => Promise<{ topicId: string; sequenceNumber: number }>;
  /** Look the signer up in the public directory. */
  resolve: (uaid: string) => Promise<{ topic: string; publicKey: string; book: PriceBook } | null>;
  verify: (bytes: string, sig: string) => boolean;
  /** How many receipts one identity may have relayed. Every one costs us HBAR. */
  quotaPerIdentity: number;
}

/**
 * Submits receipts it did not write and cannot forge.
 *
 * Everything here is a defence of our own wallet, not of the buyer. The buyer verifies
 * independently against the public topic and needs nothing from us — which is the reason
 * this component is allowed to exist at all. If it were load-bearing for the buyer's
 * trust, it would be exactly the middleman the project exists to remove.
 */
export class Relay {
  readonly #seen = new Set<string>();
  readonly #count = new Map<string, number>();

  constructor(private readonly deps: RelayDeps) {}

  async accept(receipt: Receipt): Promise<{ ok: true; topic: string } | { ok: false; error: string }> {
    const sig = receipt.sig;
    if (!sig) return { ok: false, error: "receipt is not signed; nothing to check it against" };

    if (!fitsOneChunk(receipt)) {
      // Trimming would invalidate the signature, so this is the signer's problem to fix.
      return { ok: false, error: "receipt is over one HCS chunk; shrink it before signing" };
    }

    const listed = await this.deps.resolve(sig.by);
    if (!listed) {
      return { ok: false, error: `${sig.by} is not in the directory; publish a listing first` };
    }

    if (!verifySignature(receipt, this.deps.verify)) {
      return { ok: false, error: "signature does not verify against the listed key" };
    }

    const key = `${sig.by}:${receipt.jobId}`;
    if (this.#seen.has(key)) return { ok: false, error: `job ${receipt.jobId} was already relayed` };

    const used = this.#count.get(sig.by) ?? 0;
    if (used >= this.deps.quotaPerIdentity) {
      return { ok: false, error: `${sig.by} has reached its relay quota` };
    }

    await this.deps.submit(listed.topic, receipt);
    this.#seen.add(key);
    this.#count.set(sig.by, used + 1);
    return { ok: true, topic: listed.topic };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/relay` — expected PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add apps/relay
git commit -m "A relay that submits what it cannot forge"
```

---

### Task 5: Prove it with a service that is not ours

**Files:**
- Create: `scripts/toy-adopter.mjs`
- Test: run by hand, recorded in the README

**Interfaces:** consumes everything above.

- [ ] **Step 1: Write the toy adopter**

```js
// scripts/toy-adopter.mjs
/**
 * A service that is not this one, selling something that is not web work.
 *
 * The point of the whole settlement-rail design is that the receipt machinery is not
 * about browsers. This is the smallest thing that proves it: a word-count endpoint, priced
 * per token, emitting a signed receipt through the same gate an adopter would install.
 *
 *   node scripts/toy-adopter.mjs
 */
import { createServer } from "node:http";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { hashCanonical } from "../packages/protocol/src/index.ts";
import { buildReceipt, decideSettlement, quoteFor } from "../packages/gate/src/index.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const config = {
  capability: "text.wordcount",
  book: { base: "1000", perStep: "0", perPage: "0", perSecond: "0", ceiling: "1000000", per: { tokens: "5" } },
  price: (req) => ({ tokens: String(req.body.text ?? "").split(/\s+/).filter(Boolean).length }),
  evidence: (out) => ({ output: hashCanonical(out) }),
  delivered: (out) =>
    out.words > 0 ? { ok: true } : { ok: false, why: "no words to count. Nothing was charged." },
};

const identity = {
  alg: "ed25519",
  by: "uaid:aid:toyadopter",
  sign: (bytes) => nodeSign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64url"),
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};

  const quote = quoteFor(config, { body });
  const out = { words: quote.units.tokens };
  const decision = decideSettlement(config, out);

  const receipt = buildReceipt(config, {
    jobId: `toy-${Date.now()}`,
    units: quote.units,
    out,
    amount: quote.amount,
    charged: decision.settle ? quote.amount : "0",
    payer: "0.0.10513903",
    payTo: "0.0.999",
    network: "hedera:testnet",
    asset: "0.0.0",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: decision.settle ? "ok" : "failed",
    identity,
  });

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ result: out, quote, receipt, publicKey: publicKey.export({ type: "spki", format: "der" }).toString("hex") }, null, 2));
}).listen(8410, () => console.log("toy adopter on :8410 — POST {\"text\":\"...\"}"));
```

- [ ] **Step 2: Run it and buy from it**

```bash
node scripts/toy-adopter.mjs &
curl -s -X POST localhost:8410 -H 'content-type: application/json' -d '{"text":"one two three four five"}'
```
Expected: JSON with `quote.amount` of `"1025"` (base 1000 + 5 tokens at 5), a receipt at `v: 4` with `work: {tokens: 5}`, `evidence.output` a `sha256:` hash, and a `sig`.

- [ ] **Step 3: Verify the signature independently**

```bash
curl -s -X POST localhost:8410 -H 'content-type: application/json' -d '{"text":"one two three"}' > /tmp/toy.json
npx tsx -e "
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { verifySignature } from './packages/protocol/src/index.ts';
const { receipt, publicKey } = JSON.parse(readFileSync('/tmp/toy.json','utf8'));
const key = createPublicKey({ key: Buffer.from(publicKey,'hex'), format: 'der', type: 'spki' });
console.log('signature verifies:', verifySignature(receipt, (b,s) => verify(null, Buffer.from(b,'utf8'), key, Buffer.from(s,'base64url'))));
"
```
Expected: `signature verifies: true`

- [ ] **Step 4: Confirm the empty case charges nothing**

```bash
curl -s -X POST localhost:8410 -H 'content-type: application/json' -d '{"text":""}' | grep -E '"charged"|"status"'
```
Expected: `"charged": "0"` and `"status": "failed"`

- [ ] **Step 5: Commit**

```bash
git add scripts/toy-adopter.mjs
git commit -m "A service that is not ours, emitting a receipt that verifies"
```

---

## Done when

- `npx vitest run` passes with roughly 21 new tests.
- `pnpm verify --topic 0.0.10413059 --seq 18 …` still reports **15/15**.
- `scripts/toy-adopter.mjs` emits a v4 receipt, metered in tokens, whose signature verifies against a key it published — from a service with no browser, no Playwright, and no relationship to this repository beyond importing `@low/gate`.
- Not in scope, and named: the relay's HTTP surface and HBAR wallet, key revocation, a durable retry queue in the gate. The relay class exists and is tested; standing it up on the network is a deployment task, not a design one.
