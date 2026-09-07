# Ledger of Work

**Pay-per-job access to websites that can't be turned into an API, with a receipt anyone
can verify.**

Built for the AI & Agentic Payments on Hedera track — an x402-gated service settled
through the [Blocky402](https://blocky402.com/) facilitator, with delivery receipts on
Hedera Consensus Service.

## The problem

Two gaps, and this sits at their intersection.

**Most of the web has no API.** An agent that needs a number off a site has to log in,
type into a search box, apply filters, page through results, and read one value at the
end. That isn't a fetch — it's a job. Every existing pay-per-call web service prices a
single page fetch, so the whole category of multi-step work is unserved.

**A paying agent can't tell whether it got the real thing.** When an agent pays for web
data it receives bytes and nothing else. The data could be stale, cached, partially
failed, or fabricated. The payment already settled. Nothing ties the delivered result to
a real retrieval event.

## What it does

Accepts a *job* rather than a URL, executes it against a live website, charges for the
work actually performed, and returns the result with a verifiable receipt.

**The worker** runs a defined multi-step flow against a target site — search, filter,
paginate, extract — and returns structured output.

**The meter** derives price from work done: steps executed, pages traversed, session
time. A job that resolves in two steps costs less than one that takes nine.

**The receipt** publishes a record to an HCS topic for every job: hash of the result,
source URLs, timestamps, which capability ran, how many steps it took, the price charged,
the payment reference, and the paying agent. The receipt carries the *hash*, not the
payload, so integrity is provable without republishing content that isn't ours to
redistribute.

Anyone can take a result plus a receipt and confirm the two match, that the retrieval
happened when claimed, and that the price corresponds to the work recorded. The seller
can't quietly edit history.

## Status

Early. The trust core is built and tested; the worker, service, and verifier are in
progress.

| Component | State |
| --- | --- |
| `packages/protocol` — receipt schema, canonical hashing, meter, verifier checks | **done**, 48 tests |
| `packages/worker` — site adapters + Playwright runtime | in progress |
| `packages/receipts` — HCS publisher + mirror-node reader | in progress |
| `apps/seller` — x402 resource server | planned |
| `apps/verifier` — standalone verification CLI | planned |
| `apps/buyer-cli`, `apps/mcp`, `apps/web` | planned |

## Design notes

A few constraints shaped this more than anything else. All verified against the
[Hedera exact scheme spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
and the live testnet facilitator.

**Work-based pricing is built from `exact`, not `upto`.** The x402 `upto` scheme —
authorize a maximum, settle the actual — is specified against Permit2 and ships on EVM
networks only. Every Hedera network offers `exact` alone. So the meter quotes from a
plan, then settles once for a work-derived price. Calling that "upto on Hedera" would be
wrong, and this repo doesn't.

**The price is a pure function of the recorded work.** `price(work, priceBook)` takes no
clock, no database, and no network. That is what lets an independent verifier recompute
the charge from `receipt.work` and assert the price matches the work claimed — rather
than taking our word for it.

**The paying agent's identity can't be read off the transaction.** The scheme requires
`transactionId.accountId == extra.feePayer`, so a settled transaction always names the
*facilitator*. The settlement response's `payer` field isn't portable either — it means
the buyer in some implementations and the fee payer in others. The buyer is captured from
`/verify` before settling and cross-checked against the transaction's net sender on the
mirror node.

**Receipts fit in one HCS chunk.** Messages over 1024 bytes are split across
transactions, and the mirror node REST API does not reassemble them. A size assertion
keeps receipts under the limit so any reader stays simple.

**Canonical JSON, or verification is a coin flip.** `JSON.stringify` serialises keys in
insertion order, so two encoders can agree on a value and disagree on its hash. Both
sides canonicalise — sorted keys, no insignificant whitespace — and the round-trip is
tested.

## Development

```bash
pnpm install
pnpm test        # protocol suite: canonical hashing, meter, verifier
pnpm typecheck
```

Copy `.env.example` to `.env` and fill in testnet credentials from
[portal.hedera.com](https://portal.hedera.com). Accounts must be **ECDSA** — the Hedera
exact scheme verifies signatures against the account key, and ED25519 fails signature
recovery.

## License

Apache-2.0
