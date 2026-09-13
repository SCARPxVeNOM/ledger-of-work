# A settlement rail with receipts, as a drop-in

**Status:** design, approved 2026-09-12. Not started.

## What this is

Today this repository is a seller: it performs multi-step web jobs, charges for them over
x402 on Hedera, and publishes a receipt anyone can verify. The parts that make that
trustworthy — metered pricing against a published book, hashed evidence, a third-party
witness, an on-chain receipt, an independent verifier — are not specific to web jobs. They
are specific to *paying software for work*, which is a problem every agent marketplace has
and none of them has solved.

This design turns those parts into something another service installs: a middleware that
takes payment over x402 on Hedera and emits a receipt its buyers can verify without
trusting the seller, us, or the marketplace that introduced them.

Our four web capabilities stop being the product and become the reference implementation.

## What was decided, and what was rejected

Five decisions, each with the alternative that lost and why.

**The adopter signs; we relay.** Not a hosted API that publishes on their behalf — that
would make us the trusted third party this project exists to remove, and a single point of
failure for every adopter's audit trail. Not a library that requires them to hold HBAR
either, which is correct but adds an account, a balance and key management before anyone
can emit a single receipt. They sign with their own key; we pay the fee and submit. We can
publish and we cannot forge.

**Middleware they install, not a gateway in front of them.** A gateway would be adopted
faster and requires no code, and it would route their customers' data through us. A
product that says "you need not trust the seller" cannot have a deployment model that
requires trusting us with the payload. Middleware keeps their data in their process; the
only thing crossing our wire is a receipt that is hashes and numbers.

**A capped, validated set of named units and artifacts.** Not arbitrary keys, because the
HCS chunk limit is 1024 bytes and an unbounded schema makes that limit the adopter's
problem at the worst moment — in front of a buyer who has paid. Not fixed slots
reinterpreted by the price book either; a receipt reading `pages: 12400` when it means
tokens is the precise kind of dishonesty this project exists not to commit. Four units and
four artifacts, names to 12 characters, enforced at build time.

**A topic per adopter, by default.** Not one shared topic. The property that makes this
infrastructure rather than a platform is that an adopter can leave: if their whole history
lives in a topic we control, then "verifiable without trusting anyone" is true for their
buyers and false for them.

**Positioning is the settlement rail plus the receipt, together.** Payment without a
receipt is what already exists; a receipt without payment has no natural point of
collection.

## Architecture

```
THEIR SERVER                          OURS                    ANYONE
┌──────────────────────┐      ┌──────────────────┐      ┌──────────────┐
│  their handler       │      │   facilitator    │      │  verifier    │
│  + @low/gate         │─402─▶│   (Blocky402)    │      │  (existing)  │
│    ├ prices the job  │      │                  │      │              │
│    ├ verifies+settles│─────▶│   relay          │      │  reads their │
│    ├ hashes evidence │      │   pays HBAR,     │─HCS─▶│  topic, needs│
│    └ signs a receipt │──────│   submits, never │      │  nothing from│
│  their Hedera key ───┘      │   forges         │      │  us          │
└──────────────────────┘      └──────────────────┘      └──────────────┘
```

The verifier is not in our path. A buyer resolves the adopter's HCS-14 identity in the
directory, gets their topic, their price book and their public key, and checks the receipt
against those. We appear nowhere in that chain of trust, which is the whole point.

## Components

### 1. `@low/protocol` — receipt schema v4

Depends on nothing. Generalises two fields, adds one.

```ts
interface Work     { [unit: string]: number }   // ≤4 keys, each ≤12 chars
interface Evidence {
  /** Named artifact commitments, `sha256:<hex>`. ≤4 entries, names ≤12 chars. */
  [name: string]: string;
}
interface Signature {
  alg: "ed25519" | "ecdsa-secp256k1";
  by: string;    // HCS-14 uaid of the signer
  sig: string;   // base64url over canonical(receipt without this field)
}
```

`steps`, `pages`, `sessionMs`, `pageHash` and `screenshotHash` become reserved names, so
every receipt already on the topic is valid v4 without translation, and `verifyReceipt`
keeps reading v1–v3 exactly as it does now.

**One correction found while reviewing this.** An existing receipt's `evidence` is not
purely hashes — sequence 55 carries `{ finalUrl, pageHash, screenshotHash }`, and
`finalUrl` is a URL. Typing `Evidence` as `{ [name: string]: sha256 }` would reject a
receipt we have already published, which contradicts the compatibility claim two paragraphs
above. So `finalUrl` is not an artifact and does not live in `Evidence`: it moves to its own
optional field on the receipt, where it belongs, since it is context about the capture
rather than a commitment to a file. Artifacts are hashes, and the type can say so
truthfully.

`assertFitsOneChunk(receipt)` joins the existing `fitsOneChunk`, throwing with the field to
drop named. The caps exist so this is reachable from a unit test rather than from a buyer.

### 2. `@low/gate` — the middleware

The only surface an adopter writes against. Depends on `@low/protocol` and a signer.

```ts
app.post("/summarise", gate({
  price:    (req) => ({ tokens: estimate(req) }),
  book:     PRICE_BOOK,
  evidence: (out) => ({ output: out.text }),
  delivered:(out) => out.text.length > 0
    ? { ok: true }
    : { ok: false, why: "the model returned nothing. Nothing was charged." },
  identity: { uaid, key },
  relay:    RELAY_URL, // no domain is registered; the host is configuration
}), handler);
```

Four responsibilities, each testable alone: **price** from the published book, **settle**
through the facilitator, **commit** by hashing declared evidence, **sign** the canonical
receipt. Anything after signing belongs to someone else.

`delivered` carries over the rule learned the hard way here: a job that completes without
producing what was sold charges nothing. For a search, finding nothing is an answer; for a
capture it is a miss. The adopter decides, because only they can.

Its shape matches `SiteAdapter.delivered` as already implemented — `{ ok: true } | { ok:
false; why }` rather than a boolean — because the `why` is what reaches the buyer, and a
buyer told only "no" cannot act on it.

**This component must stay small.** It is four functions and a signature. Retries beyond
the relay queue, caching, dashboards and metrics do not belong in it. An adopter who cannot
read it has to trust it, and trust is what we are selling against.

### 3. `apps/relay` — the hosted part

Depends on `@low/protocol` and `@low/receipts`.

Accepts a signed receipt, verifies the signature against the claimed identity, resolves
that identity in the directory to a topic, submits, and pays the fee. It verifies before
submitting — not to protect the buyer, who verifies independently, but so we do not pay to
publish nonsense.

Refuses identities absent from the directory. Dedupes on `jobId`. Enforces a per-identity
quota, because every submission spends our HBAR.

### 4. The verifier — one check changes

`Submitted by the expected service account` currently compares `payer_account_id` to the
expected submitter. Under the relay that field is us, for every adopter, so the check stops
meaning anything.

It becomes: **the signature verifies against the identity the receipt claims, and that
identity resolves in the directory to this topic.** Strictly stronger — it proves who
*asserted* rather than who *submitted*. Receipts carrying no `sig` keep the old check,
because for those the submitter genuinely was the seller.

### 5. `@low/identity` — adopter registration

Existing HCS-14 and directory topic, plus publishing `uaid → { topic, priceBook,
publicKey }`. This is what lets a buyer verify a receipt from a seller they have never
heard of.

## Data flow

```
buyer → POST /summarise
          ↓  price from the published book
       ← 402  payment-required
buyer → POST /summarise + payment-signature
          ↓  1. verify with facilitator      (no money moved)
          ↓  2. run the handler
          ↓  3. hash declared evidence
          ↓  4. settle                        ← money moves here
          ↓  5. sign
       ← 200  { result, receipt, artifacts }  ← buyer holds it now
          ↓  6. relay → HCS                   (asynchronous)
```

Settle before publish, because a receipt written before settlement can be contradicted by a
settlement that then fails. Work before settle, because a job that fails must charge
nothing.

**Step 5 before step 6 answers the relay's worst failure.** A relay introduces a new way to
be paid and leave no record. Returning the signed receipt in the HTTP response means the
buyer holds evidence before anything is on chain; the signature already binds the seller to
every claim in it. Publication adds consensus timestamp and immutability, which are real
and which the buyer need not wait on. A relay outage delays permanence; it cannot destroy
evidence.

## Failure modes

| What breaks | What happens |
| --- | --- |
| Work throws | No settlement. Receipt published, `status: failed`, `charged: 0`. |
| Work returns nothing | `delivered()` decides. Same as above if it says no. |
| Facilitator rejects payment | 402 again. No work, nothing to receipt. |
| Settlement fails after work | Charged 0. The work was the seller's cost. |
| Relay down | Buyer holds the signed receipt. Queued, retried, published late. |
| Relay rejects the signature | Integration bug, surfaced loudly at integration time. |
| Receipt over 1024 bytes | Build-time failure naming the field to drop. |
| We censor an adopter | They hold the key and own the topic; they publish directly. |
| Replayed receipt | Deduped on `jobId`. A cost defence, not a correctness one. |
| Adopter's key compromised | Every receipt they signed becomes suspect. See below. |

## Testing

Following the existing shape: pure logic unit-tested exhaustively, seams tested with fakes,
and the network exercised by scripts rather than by the suite.

- **Schema (v4).** Caps enforced; reserved names accepted; every existing v1–v3 receipt on
  topic `0.0.10413059` still verifies. That last one is the regression that matters and
  should run against real messages, not fixtures.
- **Signing.** A receipt signed by one key does not verify against another. A receipt with
  one byte changed fails. The canonical bytes exclude the signature field itself.
- **Gate.** Prices from the book; refuses to settle when `delivered()` says no; returns the
  signed receipt even when the relay is unreachable. The last is the one that protects a
  buyer, so it is the one to write first.
- **Relay.** Rejects an unregistered identity, a bad signature, a duplicate `jobId`, and a
  receipt whose claimed topic is not the one the directory names.
- **Verifier.** A relayed receipt verifies on signature rather than submitter; a legacy
  receipt still verifies on submitter.
- **End to end.** Extend `scripts/two-buyers.mjs`: stand up a toy adopter service behind
  the gate, buy from it with the two test accounts, and verify the receipt with the public
  verifier. That is the acceptance test — a receipt produced by a service that is not the
  seller in this repository.

## What this does not solve

**Key compromise has no revocation.** A stolen signing key forges receipts indefinitely.
HCS being append-only makes a revocation record expressible — publish a retirement, and
verifiers reject receipts signed after that consensus timestamp — but it is real work and
is scoped as a follow-on rather than pretended to be free.

**We pay every fee.** The relay makes an existing weakness concrete: this project has no
rate limiting anywhere. A per-identity quota is the minimum, and it has to exist before the
relay is public.

**Marketplaces may not want this yet.** Most settle on reputation and escrow and are not
asking for cryptographic delivery proofs. The design is deliberately useful without an
adopter — the gate is how our own seller should work regardless — but the bet that the pain
is felt rather than merely real is a bet, and it is unproven.

**One runtime.** Node first. Python only if someone asks, and the honest cost of a second
runtime is a second implementation of canonical hashing, which is exactly the kind of thing
that drifts.

## Build order

Five components, one dependency chain. A single plan can carry them, but not in any order.

1. **Schema v4 and signing**, in `@low/protocol`. Everything else depends on it, and it is
   the only part that touches receipts already on chain. Done when v1–v3 receipts on topic
   `0.0.10413059` still verify and a tampered signature fails.
2. **Verifier check.** Signature-or-submitter, so v4 receipts are verifiable before any
   exist.
3. **`@low/gate`.** Usable against our own seller first, which is the honest way to find out
   whether the interface is any good before asking a stranger to adopt it.
4. **Adopter registration** in `@low/identity`.
5. **`apps/relay`**, last, because until 1–4 exist there is nothing for it to relay, and it
   is the only component that spends money.

## Follow-ons, deliberately not in scope

Key revocation records. A second language runtime. Streaming or per-second settlement.
Anything resembling a dashboard.
