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

**Working end to end on Hedera testnet.** Two real jobs have been quoted, paid for
through the Blocky402 facilitator, executed against live sites, receipted on HCS, and
independently verified.

| Component | State |
| --- | --- |
| `packages/protocol` — receipt schema, canonical hashing, meter, verifier checks | done |
| `packages/worker` — site adapters, Playwright runtime, work meter | done |
| `packages/receipts` — HCS publisher + mirror-node reader | done |
| `apps/seller` — x402 resource server | done |
| `apps/buyer-cli` — buying agent | done |
| `apps/verifier` — independent verification CLI | done |
| `apps/mcp` — MCP server for buying agents | done |
| `apps/web` — demo UI | done |
| HTS token as payment asset | done |
| Agent card on Hedera File Service | done |

107 tests, none of which touch the network.

## Evidence

Receipts topic: [`0.0.10413059`](https://hashscan.io/testnet/topic/0.0.10413059)

Two jobs against the same capability, differing only in size:

| Job | Steps | Pages | Charged |
| --- | --- | --- | --- |
| 3 quotes tagged "love" | 3 | 1 | 312,000 tinybar |
| 100 quotes, unfiltered | 12 | 10 | 1,572,000 tinybar |

A 5x price difference for 4x the work, settled exactly, on chain. That spread is the
whole argument for pay-per-job over pay-per-call.

The same job also settles in an HTS token ([`0.0.10416991`](https://hashscan.io/testnet/token/0.0.10416991),
"WORK", 2 decimals) at a published rate of 0.001 units per tinybar — so the 312,000-tinybar
quote becomes 3.12 WORK. An agent holding a stablecoin should not have to hold the
network's native asset to buy anything.

Verifying the first one, from public data only:

```
PASS  Receipt message present and unchunked
PASS  Submitted by the expected service account
PASS  Receipt parses at a known schema version
PASS  Result matches the recorded hash
PASS  Consensus timestamp is coherent with the claimed finish   1792ms after finishedAt
PASS  Settlement succeeded for exactly the charged amount       312000 tinybar to 0.0.10410493
PASS  Named paying agent is a net sender in the transaction     0.0.10410543 debited
PASS  Quote follows the published price book
PASS  Charged exactly what was quoted
PASS  Work performed, priced for comparison                     matches the charge exactly

VERIFIED — 10/10 checks passed
```

Change one character of the result and the fourth check goes red while the rest stay
green — which is what makes it evidence rather than decoration. The verifier exits
non-zero on failure.

## Try it

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env          # fill in two ECDSA testnet accounts

pnpm seller                   # terminal 1
pnpm buy --capability quotes.search_and_extract --param tag=love --param max=3
pnpm verify --topic <id> --seq <n> --result ./result.json \
  --capability quotes.search_and_extract --submitter <seller account>
```

The verifier needs no credentials and never contacts the seller. It reads the public
mirror node, so anyone can run it — including someone who assumes the seller is lying.

### As an agent, over MCP

`pnpm mcp` exposes three tools over stdio: `list_capabilities` reads the seller's
manifest live, `quote_job` prices a job for free, and `buy_job` pays and runs it.
`buy_job` takes a `maxTinybar` ceiling and refuses anything above it — an autonomous
agent should not pay a price it did not expect:

```
spend limit too low -> REFUSED: quote 213000 tinybar exceeds your limit of 1000; not paying
within limit        -> paid 213000 tinybar, receipt topic 0.0.10413059 seq 4
```

No API key and no account with the seller. The agent discovers what is for sale, decides
whether the price is worth it, pays from its own wallet, and walks away with a receipt.

## Design notes

A few constraints shaped this more than anything else. All verified against the
[Hedera exact scheme spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
and the live testnet facilitator.

**Work-based pricing is built from `exact`, not `upto`.** The x402 `upto` scheme —
authorize a maximum, settle the actual — is specified against Permit2 and ships on EVM
networks only. Every Hedera network offers `exact` alone. So the meter quotes from a
plan, then settles once for a work-derived price. Calling that "upto on Hedera" would be
wrong, and this repo doesn't.

**Pricing is a pure function.** `price(work, priceBook)` takes no clock, no database and
no network, so anyone holding the published price book can reproduce any number this
service quotes. That reproducibility is what the verifier's meter check rests on.

**The paying agent's identity can't be read off the transaction.** The scheme requires
`transactionId.accountId == extra.feePayer`, so a settled transaction always names the
*facilitator*. The settlement response's `payer` field isn't portable either — it means
the buyer in some implementations and the fee payer in others. The buyer is captured from
`/verify` before settling and cross-checked against the transaction's net sender on the
mirror node.

**The verifier checks the quote, not the bill.** Because `exact` is the only scheme
available, the buyer signs for one definite amount *before* the work happens, and the
seller absorbs the difference when reality diverges from the plan. So the receipt records
the plan and the actual work side by side, and the verifier checks that the *quote*
followed the published price book — not that the charge equals the price of the work
performed. Checking the latter would fail every honest job where the estimate was
imperfect, which is most of them. The variance is reported so the absorption is visible
rather than something the seller can quietly pocket.

**The catalogue is published on chain, not just served.** The manifest also lives in a
Hedera File Service file, so a buyer can check the price book they were quoted against
the one the seller committed to publicly. Reading it from the same server that produced
the receipt would be circular — a seller could quote against one price book and verify
against another. Caveat worth stating: HFS file *contents* are not exposed over the
mirror REST API, so reading the card needs an account, while the receipt path stays
keyless.

**Prices are metered in tinybars and converted at a published rate.** The price book is
denominated in tinybars whatever the buyer pays in; a non-HBAR asset declares its own
`unitsPerTinybar` in the manifest, so a buyer can reproduce the number without asking.
Conversion is integer-only and rounds **up** — the exact scheme rejects a payment that
credits less than `amount`, so rounding down would under-bill and then fail settlement.
The rate is fixed and declared rather than oracle-derived, because a rate that moves
makes yesterday's receipt unverifiable today.

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
