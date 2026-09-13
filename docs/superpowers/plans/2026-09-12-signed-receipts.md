# Signed Receipts Implementation Plan

**Status: complete, 2026-09-12.** All seven tasks landed. 470 tests pass; receipts 18 and
55 on topic `0.0.10413059` still verify 15/15. Plan 2 — `@low/gate` and `apps/relay` — is
unstarted.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a receipt carry its own proof of authorship and describe any metered work, so it can be published by someone other than the seller without weakening what it proves.

**Architecture:** Receipt schema goes to v4 inside `packages/protocol`. Three generalisations — named work units, named evidence artifacts, and a detached signature — each guarded by caps so an oversized receipt fails at build time rather than in front of a paying buyer. The verifier's identity check moves from "who submitted this to HCS" to "who signed it", which is strictly stronger and is what makes a relay possible in Plan 2.

**Tech Stack:** TypeScript, Node 22, vitest, `@hiero-ledger/sdk` for key handling, pnpm workspaces.

## Global Constraints

- **Receipts already on chain must keep verifying.** Topic `0.0.10413059` holds 57 receipts at v1–v3. Every task that touches the schema or the verifier must leave them passing.
- **1024 bytes.** `HCS_CHUNK_BYTES` is the hard limit; the mirror REST API does not reassemble chunks. A v3 receipt has already come within 2 bytes of it.
- **Caps:** at most 4 work units and 4 evidence artifacts, names at most 12 characters, matching `/^[a-zA-Z][a-zA-Z0-9]*$/`.
- **Reserved names:** `steps`, `pages`, `sessionMs` (units) and `pageHash`, `screenshotHash` (artifacts) keep their existing meaning and rates.
- **No network in tests.** The suite never touches the network; live checks go in `scripts/`.
- **Commit style:** no Claude attribution, no `Co-Authored-By`.
- Run a single test with `npx vitest run <path> -t "<name>"`; run everything with `npx vitest run`.

---

### Task 1: Work units, capped and validated

**Files:**
- Modify: `packages/protocol/src/types.ts`
- Create: `packages/protocol/src/units.ts`
- Test: `packages/protocol/test/units.test.ts`

**Interfaces:**
- Consumes: `HCS_CHUNK_BYTES` from `types.ts`.
- Produces: `type Work = Record<string, number>`; `RESERVED_UNITS: readonly string[]`; `MAX_UNITS = 4`; `MAX_UNIT_NAME = 12`; `assertValidUnits(work: Work, kind: "unit" | "artifact"): void` throwing `UnitError`.

- [x] **Step 1: Write the failing test**

```ts
// packages/protocol/test/units.test.ts
import { describe, expect, it } from "vitest";
import { assertValidUnits, RESERVED_UNITS, UnitError } from "../src/units.js";

describe("work unit names", () => {
  it("accepts the reserved names an existing receipt uses", () => {
    expect(() => assertValidUnits({ steps: 2, pages: 1, sessionMs: 343 }, "unit")).not.toThrow();
    expect(RESERVED_UNITS).toContain("sessionMs");
  });

  it("accepts names a metered service would choose", () => {
    expect(() => assertValidUnits({ tokens: 12400, gpuMs: 830 }, "unit")).not.toThrow();
  });

  it("refuses more than four units, naming the limit", () => {
    expect(() => assertValidUnits({ a: 1, b: 2, c: 3, d: 4, e: 5 }, "unit")).toThrow(/at most 4/);
  });

  it("refuses a name too long to be cheap", () => {
    expect(() => assertValidUnits({ thisNameIsFarTooLong: 1 }, "unit")).toThrow(/12 characters/);
  });

  it("refuses names that are not plain identifiers", () => {
    // A name with a quote or a brace costs extra bytes once JSON-escaped, and reads as an
    // injection attempt in anything that renders the receipt.
    expect(() => assertValidUnits({ "a b": 1 }, "unit")).toThrow(/letters and digits/);
    expect(() => assertValidUnits({ "1st": 1 }, "unit")).toThrow(/letters and digits/);
  });

  it("refuses values that are not countable", () => {
    expect(() => assertValidUnits({ tokens: -1 }, "unit")).toThrow(/non-negative/);
    expect(() => assertValidUnits({ tokens: 1.5 }, "unit")).toThrow(/non-negative/);
  });

  it("says which kind it is complaining about", () => {
    expect(() => assertValidUnits({ a: 1, b: 2, c: 3, d: 4, e: 5 }, "artifact")).toThrow(/artifact/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/units.test.ts`
Expected: FAIL — `Failed to resolve import "../src/units.js"`

- [x] **Step 3: Write minimal implementation**

```ts
// packages/protocol/src/units.ts
/**
 * What a receipt may call the things it counts.
 *
 * A receipt has 1024 bytes and no more, so every key name is spent from the same budget
 * as the sources list. Capping the count and the length is what keeps "name your own
 * units" from becoming "discover at runtime that your receipt cannot be published",
 * which on a paid job means discovering it in front of a buyer who has already paid.
 */

export const MAX_UNITS = 4;
export const MAX_UNIT_NAME = 12;

/** Names that predate generic units and keep their meaning, so old receipts stay valid. */
export const RESERVED_UNITS = ["steps", "pages", "sessionMs"] as const;
export const RESERVED_ARTIFACTS = ["pageHash", "screenshotHash"] as const;

const NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

/** Throw unless every key is a cheap, legible name and every value is countable. */
export function assertValidUnits(map: Record<string, number | string>, kind: "unit" | "artifact"): void {
  const names = Object.keys(map);
  if (names.length > MAX_UNITS) {
    throw new UnitError(
      `a receipt carries at most ${MAX_UNITS} ${kind}s; got ${names.length} (${names.join(", ")})`,
    );
  }
  for (const name of names) {
    if (name.length > MAX_UNIT_NAME) {
      throw new UnitError(`${kind} name \`${name}\` is over ${MAX_UNIT_NAME} characters`);
    }
    if (!NAME.test(name)) {
      throw new UnitError(`${kind} name \`${name}\` must be letters and digits, starting with a letter`);
    }
    const value = map[name];
    if (kind === "unit" && (!Number.isInteger(value) || (value as number) < 0)) {
      throw new UnitError(`${kind} \`${name}\` must be a non-negative whole number, got ${value}`);
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/units.test.ts`
Expected: PASS, 7 tests

- [x] **Step 5: Commit**

```bash
git add packages/protocol/src/units.ts packages/protocol/test/units.test.ts
git commit -m "Name the things a receipt counts, and cap them

A receipt has 1024 bytes, so a key name is spent from the same budget as the
sources list. Four units, twelve characters, plain identifiers — and the
reserved names an existing receipt already uses are among them, so nothing on
the topic stops being valid."
```

---

### Task 2: Price any named unit, without changing what existing receipts cost

**Files:**
- Modify: `packages/protocol/src/types.ts` (extend `PriceBook`)
- Modify: `packages/protocol/src/price.ts`
- Test: `packages/protocol/test/price.test.ts` (append)

**Interfaces:**
- Consumes: `assertValidUnits` from Task 1.
- Produces: `PriceBook` gains `per?: Record<string, string>`; `price(work: Record<string, number>, book: PriceBook): PriceBreakdown` accepts named units.

- [x] **Step 1: Write the failing test**

```ts
// append to packages/protocol/test/price.test.ts
// `price` is already imported at the top of this file.
describe("pricing a unit the price book names itself", () => {
  const book = {
    base: "60000",
    perStep: "45000",
    perPage: "90000",
    perSecond: "9000",
    ceiling: "6000000",
    per: { tokens: "5", gpuMs: "2" },
  };

  it("charges the named rate for a named unit", () => {
    // base 60000 + 1000 tokens at 5 = 65000
    expect(price({ tokens: 1000 }, book).total).toBe(65000n);
  });

  it("adds named units to the reserved ones rather than replacing them", () => {
    // base 60000 + 2 steps at 45000 + 1000 tokens at 5 = 155000
    expect(price({ steps: 2, tokens: 1000 }, book).total).toBe(155000n);
  });

  it("prices an existing receipt's work exactly as it did before", () => {
    // The regression that matters: receipt 55 is {steps:2, pages:1, sessionMs:343}.
    // base 60000 + 90000 + 90000 + 9000 = 249000
    expect(price({ steps: 2, pages: 1, sessionMs: 343 }, book).total).toBe(249000n);
  });

  it("refuses a unit the book does not price, rather than charging zero for it", () => {
    // Silently charging nothing for an unpriced unit is how a seller gives work away
    // and never finds out.
    expect(() => price({ widgets: 10 }, book)).toThrow(/widgets/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/price.test.ts -t "named rate"`
Expected: FAIL — total is `60000n`, the named unit contributing nothing

- [x] **Step 3: Write minimal implementation**

In `packages/protocol/src/types.ts`, add to `PriceBook`:

```ts
  /**
   * Rates for units beyond the reserved three, keyed by unit name.
   *
   * Absent on every price book written before generic units existed, which is why it is
   * optional rather than required — those books price steps, pages and seconds and have
   * nothing else to say.
   */
  per?: Record<string, string>;
```

Replace the body of `price` in `packages/protocol/src/price.ts`:

```ts
export function price(work: Record<string, number>, book: PriceBook): PriceBreakdown {
  assertCountable(work);

  const base = BigInt(book.base);
  const steps = BigInt(book.perStep) * BigInt(work.steps ?? 0);
  const pages = BigInt(book.perPage) * BigInt(work.pages ?? 0);
  const seconds = BigInt(book.perSecond) * BigInt(Math.ceil((work.sessionMs ?? 0) / 1000));

  // Anything the book does not already have a dedicated rate for must be named in `per`.
  // An unpriced unit is refused rather than charged nothing: giving work away silently is
  // a failure a seller would never be told about.
  let named = 0n;
  for (const [unit, count] of Object.entries(work)) {
    if (unit === "steps" || unit === "pages" || unit === "sessionMs") continue;
    const rate = book.per?.[unit];
    if (rate === undefined) {
      throw new TypeError(`price: the price book has no rate for \`${unit}\``);
    }
    named += BigInt(rate) * BigInt(count);
  }

  const subtotal = base + steps + pages + seconds + named;
  const ceiling = BigInt(book.ceiling);
  const ceilingHit = subtotal > ceiling;

  return {
    base,
    steps,
    pages,
    seconds,
    named,
    subtotal,
    total: ceilingHit ? ceiling : subtotal,
    ceilingHit,
  };
}
```

Add `named: bigint;` to `PriceBreakdown` in `types.ts`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol`
Expected: PASS — including every pre-existing price test unchanged

- [x] **Step 5: Commit**

```bash
git add packages/protocol/src/price.ts packages/protocol/src/types.ts packages/protocol/test/price.test.ts
git commit -m "Price a unit the book names itself

Steps, pages and seconds keep their dedicated rates, so every receipt already on
the topic prices to the same number it did. Anything else needs a rate in
\`per\`, and a unit with no rate throws rather than costing nothing — silently
giving work away is a failure the seller would never hear about."
```

---

### Task 3: Evidence as named artifacts, with `finalUrl` moved out

**Files:**
- Modify: `packages/protocol/src/types.ts`
- Test: `packages/protocol/test/evidence.test.ts`

**Interfaces:**
- Consumes: `assertValidUnits` from Task 1.
- Produces: `EvidenceRef` becomes `Record<string, string>` of `sha256:` hashes; `Receipt.finalUrl?: string` is a new top-level optional field.

- [x] **Step 1: Write the failing test**

```ts
// packages/protocol/test/evidence.test.ts
import { describe, expect, it } from "vitest";
import { assertValidUnits } from "../src/units.js";
import { readEvidence } from "../src/evidence.js";

/**
 * `finalUrl` used to live inside `evidence` alongside two hashes. It is a URL, not a
 * commitment to a file, so a type saying "evidence is a map of hashes" would have
 * rejected receipts already on the topic. It moves to its own field; the reader below is
 * what keeps old receipts working.
 */
describe("reading evidence off a receipt", () => {
  it("takes the hashes and leaves finalUrl alone on a v3 receipt", () => {
    const v3 = {
      evidence: {
        pageHash: "sha256:aa",
        screenshotHash: "sha256:bb",
        finalUrl: "https://www.whitehouse.gov/presidential-actions/",
      },
    };

    expect(readEvidence(v3)).toEqual({
      artifacts: { pageHash: "sha256:aa", screenshotHash: "sha256:bb" },
      finalUrl: "https://www.whitehouse.gov/presidential-actions/",
    });
  });

  it("reads a v4 receipt where finalUrl is its own field", () => {
    const v4 = {
      evidence: { output: "sha256:cc" },
      finalUrl: "https://example.com/x",
    };

    expect(readEvidence(v4)).toEqual({
      artifacts: { output: "sha256:cc" },
      finalUrl: "https://example.com/x",
    });
  });

  it("reports no evidence as no artifacts rather than as an error", () => {
    expect(readEvidence({})).toEqual({ artifacts: {}, finalUrl: undefined });
  });

  it("accepts up to four named artifacts", () => {
    expect(() =>
      assertValidUnits({ output: "sha256:a", logs: "sha256:b", model: "sha256:c", input: "sha256:d" }, "artifact"),
    ).not.toThrow();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/evidence.test.ts`
Expected: FAIL — `Failed to resolve import "../src/evidence.js"`

- [x] **Step 3: Write minimal implementation**

```ts
// packages/protocol/src/evidence.ts
/**
 * Reading the evidence off a receipt of any version.
 *
 * v2 and v3 put `finalUrl` inside `evidence`, next to two hashes. It is not a hash, so a
 * schema describing evidence as named artifact commitments cannot hold it — and typing it
 * that way would reject receipts that are already on the topic. From v4 it is a field of
 * its own. This reader hides that difference from everything downstream, which is the
 * only reason the verifier does not need a version branch for it.
 */
export interface ReadEvidence {
  /** Named `sha256:<hex>` commitments. Empty when the receipt carries none. */
  artifacts: Record<string, string>;
  /** Where the capture ended up, when the receipt says. */
  finalUrl: string | undefined;
}

export function readEvidence(receipt: {
  evidence?: Record<string, string> | undefined;
  finalUrl?: string | undefined;
}): ReadEvidence {
  const raw = receipt.evidence ?? {};
  const artifacts: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    // `capturedAt` is a v2 field and also not a hash; both it and finalUrl are skipped.
    if (name === "finalUrl" || name === "capturedAt") continue;
    artifacts[name] = value;
  }
  return { artifacts, finalUrl: receipt.finalUrl ?? raw.finalUrl };
}
```

In `types.ts`, change `EvidenceRef` to `export type EvidenceRef = Record<string, string>;` and add to `Receipt`:

```ts
  /**
   * Where the capture actually ended up, which may differ from where it was sent.
   * v2 and v3 carry this inside `evidence`; `readEvidence` reads either.
   */
  finalUrl?: string;
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/protocol/src/evidence.ts packages/protocol/src/types.ts packages/protocol/test/evidence.test.ts
git commit -m "Take finalUrl out of evidence, where it never belonged

Evidence is named commitments to files, and finalUrl is a URL. Typing evidence as
a map of hashes would have rejected receipt 55, which carries finalUrl beside two
of them — a compatibility break hidden inside a generalisation. It becomes its own
field, and readEvidence reads either shape so nothing downstream needs to know."
```

---

### Task 4: Fail an oversized receipt at build time

**Files:**
- Modify: `packages/protocol/src/verify.ts`
- Test: `packages/protocol/test/verify.test.ts` (append)

**Interfaces:**
- Consumes: `fitsOneChunk`, `canonicalByteLength`, `HCS_CHUNK_BYTES`.
- Produces: `assertFitsOneChunk(receipt: Receipt): void` throwing `ReceiptTooLarge`.

- [x] **Step 1: Write the failing test**

```ts
// append to packages/protocol/test/verify.test.ts
// Add `assertFitsOneChunk` to the existing import from "../src/verify.js".
describe("a receipt too large to publish", () => {
  it("throws before anyone is charged, naming the size and the limit", () => {
    const receipt = makeReceipt({ sources: Array.from({ length: 40 }, (_, i) => `https://example.com/a-fairly-long-path/${i}`) });

    expect(() => assertFitsOneChunk(receipt)).toThrow(/1024/);
  });

  it("names the largest field, so there is something to act on", () => {
    const receipt = makeReceipt({ sources: Array.from({ length: 40 }, (_, i) => `https://example.com/a-fairly-long-path/${i}`) });

    expect(() => assertFitsOneChunk(receipt)).toThrow(/sources/);
  });

  it("says nothing about a receipt that fits", () => {
    expect(() => assertFitsOneChunk(makeReceipt())).not.toThrow();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/verify.test.ts -t "too large to publish"`
Expected: FAIL — `assertFitsOneChunk is not defined`

- [x] **Step 3: Write minimal implementation**

```ts
// packages/protocol/src/verify.ts
export class ReceiptTooLarge extends Error {
  constructor(bytes: number, biggest: string) {
    super(
      `receipt is ${bytes} bytes and the HCS chunk limit is ${HCS_CHUNK_BYTES}; ` +
        `\`${biggest}\` is the largest field — drop or shorten it`,
    );
    this.name = "ReceiptTooLarge";
  }
}

/**
 * Refuse to build a receipt that cannot be published, and say which field to cut.
 *
 * `fitsOneChunk` answers yes or no, which is the right shape for a test and the wrong
 * shape for a seller: by the time a receipt is being written the buyer has paid, and "too
 * big" with no further detail leaves nothing to do. Naming the largest field turns it into
 * a decision. Reached from a unit test because the caps make it reachable.
 */
export function assertFitsOneChunk(receipt: Receipt): void {
  if (fitsOneChunk(receipt)) return;

  let biggest = "";
  let largest = -1;
  for (const [field, value] of Object.entries(receipt)) {
    const size = canonicalByteLength(value);
    if (size > largest) {
      largest = size;
      biggest = field;
    }
  }
  throw new ReceiptTooLarge(canonicalByteLength(receipt), biggest);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/protocol/src/verify.ts packages/protocol/test/verify.test.ts
git commit -m "Refuse an oversized receipt, and say which field to cut

fitsOneChunk answers yes or no, which is right for a test and useless to a seller:
by the time the receipt is written the buyer has paid, and \"too big\" leaves
nothing to do. Naming the largest field makes it a decision."
```

---

### Task 5: Sign a receipt, and verify the signature

**Files:**
- Create: `packages/protocol/src/sign.ts`
- Modify: `packages/protocol/src/types.ts`
- Test: `packages/protocol/test/sign.test.ts`

**Interfaces:**
- Consumes: `canonical` from `canonical.ts`.
- Produces: `interface Signature { alg: "ed25519" | "ecdsa-secp256k1"; by: string; sig: string }`; `signingBytes(receipt: Receipt): string`; `signReceipt(receipt, { alg, by, sign }): Receipt`; `verifySignature(receipt, verify): boolean`.

- [x] **Step 1: Write the failing test**

```ts
// packages/protocol/test/sign.test.ts
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { signReceipt, signingBytes, verifySignature } from "../src/sign.js";
import { makeReceipt } from "./fixtures.js";

/**
 * Real ed25519, not a stub. A fake signer would make every test here pass against an
 * implementation that signed the wrong bytes, which is the one thing these tests exist
 * to catch.
 */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const sign = (bytes: string) =>
  nodeSign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64url");
const verify = (bytes: string, sig: string) =>
  nodeVerify(null, Buffer.from(bytes, "utf8"), publicKey, Buffer.from(sig, "base64url"));

describe("signing a receipt", () => {
  const identity = "uaid:aid:abc;uid=0;registry=x;proto=a2a;nativeId=hedera:testnet:0.0.1";

  it("signs bytes that do not include the signature itself", () => {
    // Otherwise verifying requires knowing what the receipt looked like before signing,
    // which nobody reading it off the topic can reconstruct.
    const receipt = makeReceipt();
    const before = signingBytes(receipt);
    const signed = signReceipt(receipt, { alg: "ed25519", by: identity, sign });

    expect(signingBytes(signed)).toBe(before);
  });

  it("verifies with the key that signed it", () => {
    const signed = signReceipt(makeReceipt(), { alg: "ed25519", by: identity, sign });

    expect(verifySignature(signed, verify)).toBe(true);
  });

  it("fails when one byte of the receipt changed", () => {
    const signed = signReceipt(makeReceipt(), { alg: "ed25519", by: identity, sign });
    const tampered = { ...signed, price: { ...signed.price, charged: "1" } };

    expect(verifySignature(tampered, verify)).toBe(false);
  });

  it("fails against a different key", () => {
    const other = generateKeyPairSync("ed25519");
    const signed = signReceipt(makeReceipt(), { alg: "ed25519", by: identity, sign });
    const wrong = (bytes: string, sig: string) =>
      nodeVerify(null, Buffer.from(bytes, "utf8"), other.publicKey, Buffer.from(sig, "base64url"));

    expect(verifySignature(signed, wrong)).toBe(false);
  });

  it("reports an unsigned receipt as unsigned rather than throwing", () => {
    expect(verifySignature(makeReceipt(), verify)).toBe(false);
  });

  it("records who signed it", () => {
    const signed = signReceipt(makeReceipt(), { alg: "ed25519", by: identity, sign });

    expect(signed.sig?.by).toBe(identity);
    expect(signed.sig?.alg).toBe("ed25519");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/sign.test.ts`
Expected: FAIL — `Failed to resolve import "../src/sign.js"`

- [x] **Step 3: Write minimal implementation**

```ts
// packages/protocol/src/sign.ts
import { canonical } from "./canonical.js";
import type { Receipt, Signature } from "./types.js";

/**
 * Binding a receipt to whoever asserted it.
 *
 * Until now the seller was also the submitter, so HCS submission *was* the authentication
 * — `payer_account_id` on the message is a fact nobody can forge, and the verifier checked
 * it against the expected seller. Once a relay submits on the seller's behalf that field
 * is the relay, for every seller, and the check stops meaning anything.
 *
 * A detached signature over the canonical bytes replaces it, and proves more: who
 * *asserted* the receipt rather than who happened to hand it to the network.
 *
 * The key never comes near this module. `sign` and `verify` are supplied, because the
 * only correct place for a private key is the process that owns it, and because this
 * module is shared with a browser that must never be handed one.
 */

/**
 * Exactly the bytes a signature covers: the receipt without its own signature.
 *
 * Self-evident once stated and easy to get wrong: signing the whole object means the
 * signature covers itself, so verification would need the pre-signature form, which
 * nobody reading the receipt off the topic can reconstruct.
 */
export function signingBytes(receipt: Receipt): string {
  const { sig: _omitted, ...rest } = receipt as Receipt & { sig?: Signature };
  return canonical(rest);
}

export function signReceipt(
  receipt: Receipt,
  opts: { alg: Signature["alg"]; by: string; sign: (bytes: string) => string },
): Receipt {
  return { ...receipt, sig: { alg: opts.alg, by: opts.by, sig: opts.sign(signingBytes(receipt)) } };
}

/** True only when the receipt carries a signature and it verifies over the right bytes. */
export function verifySignature(
  receipt: Receipt,
  verify: (bytes: string, sig: string) => boolean,
): boolean {
  const sig = (receipt as Receipt & { sig?: Signature }).sig;
  if (!sig?.sig) return false;
  try {
    return verify(signingBytes(receipt), sig.sig);
  } catch {
    // A malformed signature is an unverified receipt, not a crash in the verifier.
    return false;
  }
}
```

In `types.ts` add the `Signature` interface and `sig?: Signature;` to `Receipt`, and set `RECEIPT_VERSION = 4` with `SUPPORTED_RECEIPT_VERSIONS = [1, 2, 3, 4]`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/protocol/src/sign.ts packages/protocol/src/types.ts packages/protocol/test/sign.test.ts
git commit -m "Let a receipt carry proof of who asserted it

Until now the seller was the submitter, so submission was the authentication:
payer_account_id cannot be forged and the verifier checked it. Once something
relays on the seller's behalf that field is the relay, for everyone, and the check
means nothing.

A detached signature over the canonical bytes replaces it and proves more — who
asserted the receipt rather than who handed it to the network. The signed bytes
exclude the signature, or verifying would need a form of the receipt nobody
reading it off the topic can reconstruct. Keys stay out of this module: sign and
verify are passed in, because it is shared with a browser."
```

---

### Task 6: The verifier checks the signature when there is one

**Files:**
- Modify: `packages/protocol/src/verify.ts`
- Test: `packages/protocol/test/verify.test.ts` (append)

**Interfaces:**
- Consumes: `verifySignature` from Task 5.
- Produces: `VerifyInput` gains `verifySignature?: (bytes: string, sig: string) => boolean` and `expectedSigner?: string`.

- [x] **Step 1: Write the failing test**

```ts
// append to packages/protocol/test/verify.test.ts
// Add to the existing imports at the top of this file:
//   import { verifyReceipt } from "../src/verify.js";
//   import { makeMessage, makeReceipt, makeTransaction, RESULT, SELLER } from "./fixtures.js";
//   import { hashCanonical } from "../src/hash.js";
describe("who asserted the receipt", () => {
  it("checks the submitter when the receipt carries no signature", () => {
    // Every receipt already on the topic. For these the submitter really was the seller.
    const out = verifyFixture();
    const check = out.checks.find((c) => c.id === "submitter");

    expect(check?.ok).toBe(true);
    expect(check?.label).toMatch(/submitted by/i);
  });

  it("checks the signature instead when the receipt carries one", () => {
    const signed = { ...makeReceipt(), sig: { alg: "ed25519", by: "uaid:aid:abc", sig: "zzz" } };
    const out = verifyReceipt({
      resultHash: hashCanonical(RESULT),
      message: makeMessage(signed, { payer_account_id: "0.0.999999" }), // a relay, not the seller
      transaction: makeTransaction(signed),
      expectedSubmitter: SELLER,
      expectedSigner: "uaid:aid:abc",
      verifySignature: () => true,
    });
    const check = out.checks.find((c) => c.id === "submitter");

    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/signed by/i);
  });

  it("fails a signed receipt whose signature does not verify", () => {
    const signed = { ...makeReceipt(), sig: { alg: "ed25519", by: "uaid:aid:abc", sig: "zzz" } };
    const out = verifyReceipt({
      resultHash: hashCanonical(RESULT),
      message: makeMessage(signed, { payer_account_id: "0.0.999999" }),
      transaction: makeTransaction(signed),
      expectedSubmitter: SELLER,
      expectedSigner: "uaid:aid:abc",
      verifySignature: () => false,
    });

    expect(out.ok).toBe(false);
    expect(out.checks.find((c) => c.id === "submitter")?.ok).toBe(false);
  });

  it("fails a signed receipt signed by someone other than the expected identity", () => {
    // The signature is good; the signer is not who the directory says it should be.
    const signed = { ...makeReceipt(), sig: { alg: "ed25519", by: "uaid:aid:impostor", sig: "zzz" } };
    const out = verifyReceipt({
      resultHash: hashCanonical(RESULT),
      message: makeMessage(signed, { payer_account_id: "0.0.999999" }),
      transaction: makeTransaction(signed),
      expectedSubmitter: SELLER,
      expectedSigner: "uaid:aid:abc",
      verifySignature: () => true,
    });

    expect(out.checks.find((c) => c.id === "submitter")?.ok).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/verify.test.ts -t "who asserted"`
Expected: FAIL — the signed cases fail because the submitter check still compares `payer_account_id`

- [x] **Step 3: Write minimal implementation**

Replace check 2 in `verifyReceipt`. The receipt must be parsed before this check, so move the parse block above it, then:

```ts
  // 2. Who asserted this?
  //
  // A receipt with no signature is one the seller submitted itself, and for those the
  // submitting account is the claim — it is on the message and cannot be forged. A signed
  // receipt may have been relayed by anyone, so the submitter proves nothing and the
  // signature proves more: not who handed this to the network, but who stands behind it.
  const sig = (receipt as Receipt & { sig?: Signature }).sig;
  if (!sig) {
    add(
      "submitter",
      "Submitted by the expected service account",
      input.message.payer_account_id === input.expectedSubmitter,
      `submitted by ${input.message.payer_account_id}, expected ${input.expectedSubmitter}`,
    );
  } else {
    const signerMatches = !input.expectedSigner || sig.by === input.expectedSigner;
    const verified = input.verifySignature
      ? verifySignature(receipt, input.verifySignature)
      : false;
    add(
      "submitter",
      "Signed by the expected service identity",
      signerMatches && verified,
      verified
        ? `signed by ${sig.by}${signerMatches ? "" : `, expected ${input.expectedSigner}`}`
        : `signature does not verify (claimed signer ${sig.by})`,
    );
  }
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS — all 430+ tests, including every existing verifier test

- [x] **Step 5: Verify against receipts actually on chain**

Run:
```bash
pnpm verify --topic 0.0.10413059 --seq 18 --result ./samples/result-proof.json \
  --capability oracle.capture_claim --submitter 0.0.10410493 \
  --artifacts ./samples/result-proof.page.html,./samples/result-proof.screenshot.png \
  --proof ./samples/result-proof.proof.json
```
Expected: `VERIFIED — 15/15 checks passed`. If this regresses, the compatibility promise is broken and the task is not done.

- [x] **Step 6: Commit**

```bash
git add packages/protocol/src/verify.ts packages/protocol/test/verify.test.ts
git commit -m "Check who asserted a receipt, not who posted it

An unsigned receipt was submitted by the seller, and for those the submitting
account is the claim — it is on the message and cannot be forged. A signed receipt
may have been relayed by anyone, so the submitter proves nothing while the
signature proves more.

Both paths kept, chosen by whether the receipt carries a signature, so the 57
receipts already on the topic verify exactly as before. Confirmed against
sequence 18: still 15/15."
```

---

### Task 7: Publish an adopter's key and price book in the directory

**Files:**
- Modify: `packages/receipts/src/registry.ts`
- Test: `packages/receipts/test/registry.test.ts` (append)

**Interfaces:**
- Consumes: `Listing`, `DirectoryEntry` from `registry.ts`.
- Produces: `Listing` gains `publicKey?: string` and `book?: PriceBook`; `resolveSigner(entries: DirectoryEntry[], uaid: string): { topic: string; publicKey: string; book: PriceBook } | null`.

- [x] **Step 1: Write the failing test**

```ts
// append to packages/receipts/test/registry.test.ts
// Add `resolveSigner` to the existing import from "../src/registry.js".
describe("resolving a signer from the directory", () => {
  const listing = {
    v: 1, kind: "listing" as const,
    uaid: "uaid:aid:abc", name: "Someone Else", url: "https://elsewhere.example",
    skills: [{ id: "text.summarise", from: "1000" }],
    receipts: "0.0.777", network: "hedera:testnet", at: "2026-09-12T00:00:00.000Z",
    publicKey: "302a300506032b6570032100aa",
    book: { base: "1000", perStep: "0", perPage: "0", perSecond: "0", ceiling: "9999", per: { tokens: "5" } },
  };

  it("returns the topic, key and book a verifier needs", () => {
    const found = resolveSigner([{ listing, submitter: "0.0.1", sequenceNumber: 1, at: listing.at }], "uaid:aid:abc");

    expect(found).toEqual({ topic: "0.0.777", publicKey: "302a300506032b6570032100aa", book: listing.book });
  });

  it("returns null for an identity nobody listed", () => {
    expect(resolveSigner([], "uaid:aid:nobody")).toBeNull();
  });

  it("returns null when the listing names no key, rather than a half-answer", () => {
    // A listing without a key cannot support signature verification, and returning a
    // topic without one invites a verifier to check the receipt and skip the signature.
    const { publicKey: _omit, ...noKey } = listing;
    expect(
      resolveSigner([{ listing: noKey as never, submitter: "0.0.1", sequenceNumber: 1, at: listing.at }], "uaid:aid:abc"),
    ).toBeNull();
  });

  it("takes the newest listing when an identity was listed twice", () => {
    const older = { ...listing, receipts: "0.0.111" };
    const entries = [
      { listing: older, submitter: "0.0.1", sequenceNumber: 1, at: listing.at },
      { listing, submitter: "0.0.1", sequenceNumber: 9, at: listing.at },
    ];

    expect(resolveSigner(entries, "uaid:aid:abc")?.topic).toBe("0.0.777");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/receipts/test/registry.test.ts -t "resolving a signer"`
Expected: FAIL — `resolveSigner is not defined`

- [x] **Step 3: Write minimal implementation**

Add to `Listing` in `registry.ts`:

```ts
  /**
   * The public key receipts from this identity are signed with, DER hex.
   *
   * Optional because listings predate signing. A listing without one can still be
   * discovered and bought from; its receipts simply verify on submitter, as they always
   * have.
   */
  publicKey?: string;
  /** The published price book, so a buyer can check a quote before paying it. */
  book?: PriceBook;
```

```ts
/**
 * Everything a verifier needs to check a receipt from a seller it has never heard of.
 *
 * Returns null rather than a partial answer when the listing names no key. A topic without
 * a key invites the caller to verify everything except the one claim that says who wrote
 * it, which is the check that matters most for a relayed receipt.
 *
 * Newest listing wins, by sequence number: an identity that re-lists has moved, and the
 * mirror returns messages newest-first.
 */
export function resolveSigner(
  entries: DirectoryEntry[],
  uaid: string,
): { topic: string; publicKey: string; book: PriceBook } | null {
  let best: DirectoryEntry | undefined;
  for (const entry of entries) {
    if (entry.listing.uaid !== uaid) continue;
    if (!best || entry.sequenceNumber > best.sequenceNumber) best = entry;
  }
  const listing = best?.listing;
  if (!listing?.publicKey || !listing.receipts || !listing.book) return null;
  return { topic: listing.receipts, publicKey: listing.publicKey, book: listing.book };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/receipts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/receipts/src/registry.ts packages/receipts/test/registry.test.ts
git commit -m "Publish the key and the book a stranger's receipt is checked against

A relayed receipt is verified on its signature, and a buyer who has never heard of
the seller needs somewhere to learn which key that should be. The directory
already carries the topic; it now carries the public key and the published price
book beside it.

resolveSigner returns null rather than a partial answer when a listing names no
key — a topic without one invites a caller to verify everything except who wrote
it, which for a relayed receipt is the check that matters most."
```

---

## Done when

- `npx vitest run` passes, with roughly 30 new tests.
- `pnpm verify --topic 0.0.10413059 --seq 18 …` still reports **15/15**, and `--seq 55` still reports 15/15.
- `RECEIPT_VERSION` is 4, `SUPPORTED_RECEIPT_VERSIONS` is `[1, 2, 3, 4]`.
- Nothing in `packages/worker` or `apps/seller` has changed behaviour: the seller still publishes unsigned receipts and they still verify. Signing them is Plan 2's job, along with `@low/gate` and `apps/relay`.
