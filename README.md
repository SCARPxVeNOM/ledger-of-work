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
| Real-site adapters (govinfo.gov, UVa Library Virgo) | done |
| `packages/receipts` — HCS publisher + mirror-node reader | done |
| `apps/seller` — x402 resource server | done |
| `apps/buyer-cli` — buying agent | done |
| `apps/verifier` — independent verification CLI | done |
| `apps/wallet` — the buyer's wallet as its own process | done |
| `apps/mcp` — MCP server for buying agents | done |
| `apps/web` — demo UI | done |
| `apps/verify-page` — the verifier as a static page, no backend | done |
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

### A real site with no API at all

`virgo.catalogue_search` searches the University of Virginia Library catalogue. It is the
only site in [`scripts/survey-sites.mjs`](scripts/survey-sites.mjs) that satisfies the
whole pitch on its own — run it yourself:

```
site                          fetchable  crawlable  apiless
quotes.toscrape.com           yes        yes        no       <- has /api/quotes
books.toscrape.com            yes        yes        yes
govinfo.gov                   no         yes        no       <- has api.govinfo.gov
search.lib.virginia.edu       no         yes        yes      <- both
congress.gov                  no         no         no
leginfo.legislature.ca.gov    yes        no         yes      <- Disallow: /
www.gutenberg.org             yes        no         no
```

A plain GET of a Virgo search returns a 2,198-byte application shell with no results in
it, nothing answers at `/catalog.json`, `/api/search`, `?format=json` or
`/opensearch.xml`, and the site serves no robots.txt at all. Results load by a
**"Load More Results"** button rather than by URL, so reaching the fortieth record
genuinely requires clicking — there is no page-2 address to fetch.

The survey is worth running before you trust that table. Its first version reported
govinfo as API-less, because Node's fetch fails on `api.govinfo.gov` where curl succeeds
and the code recorded that connection failure as evidence of absence. It now distinguishes
"checked and absent" from "could not check", and falls back to curl.

That survey also corrected something this README used to claim: `quotes.toscrape.com`
does have a JSON API at `/api/quotes`, so the login flow demonstrates "not a fetch" but
not "no API".

### A real site, not just a sandbox

`govinfo.federal_register_issues` clicks through the Federal Register browse tree on
**govinfo.gov** — a real US Government Publishing Office service. It is the sharpest
demonstration of the whole premise:

```
plain GET of the same URL      1,762 bytes
  mentions "Federal Register"  false
  accordion markup             false
  any issue dates              false

the job                        8 issues with dates and printed page ranges
  step 1  open the Federal Register browse tree
  step 2  expand 2025
  step 3  expand January
```

govinfo is an Angular application. The browse tree is nested collapsed accordions —
year, then month, then day — each loading its children only when clicked, and there is
no URL that jumps to a month's issue list. A single request cannot produce this result
no matter how it is constructed.

**robots.txt:** govinfo disallows `/search/`. This adapter never touches it — it uses
only `/app/collection/...`, which is not disallowed, identifies itself in the user
agent, and paces its clicks.

**The honest caveat:** govinfo also publishes an official API at `api.govinfo.gov`. So
this site is a strong example of *"not a fetch"* and a weak example of *"no API"*. It is
here to prove the adapter interface generalises to a real, JS-rendered government site —
not to claim the data is otherwise unobtainable. Every genuinely API-less alternative
examined either disallowed crawling outright (`leginfo.legislature.ca.gov` disallows
everything; `congress.gov` disallows search and 403s plain clients) or blocked
unauthenticated readers, which is itself a finding about this market.

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
pnpm wallet                   # terminal 2 — holds the buyer's key
pnpm buy --capability quotes.search_and_extract --param tag=love --param max=3
pnpm verify --topic <id> --seq <n> --result ./result.json \
  --capability quotes.search_and_extract --submitter <seller account>
```

The verifier needs no credentials and never contacts the seller. It reads the public
mirror node, so anyone can run it — including someone who assumes the seller is lying.

### In a browser, with nothing installed

`pnpm build:page` produces an 8 KB static site that runs the verifier entirely in the
browser against the public mirror node — no backend, no account, no key. It shares
`verifyReceipt` verbatim with the CLI rather than reimplementing the checks, because two
verifiers would eventually disagree and a disagreement between two things that both claim
to prove delivery is worse than having one.

Making that possible meant splitting the trust core: `@low/protocol/portable` is
everything that runs anywhere, and hashing — the one part needing a platform primitive —
lives outside it. Node hashes with `node:crypto`, the browser with Web Crypto, and both
hash the *same* canonical bytes because the encoding is shared code.

A receipt is shareable as a link:

```
?topic=0.0.10413059&seq=14&submitter=0.0.10410493&capability=virgo.catalogue_search
```

See [`docs/DEPLOY.md`](docs/DEPLOY.md). Publishing it is one repository setting.

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

**Failed jobs settle nothing and are still recorded.** On `exact` there is no
zero-amount settlement to fall back on, so the only honest response to a job that broke
is not to charge for it. The receipt is published anyway, with `status: "failed"`,
`charged: "0"`, no transaction id, and the work that was performed before it broke.
Receipt [seq 12](https://hashscan.io/testnet/topic/0.0.10413059) is a real one: 57
seconds of browser work, nothing charged.

The receipt is published *after* settlement, because a receipt written beforehand cannot
carry a transaction id and binding the result to the payment is its entire purpose. That
leaves a short window in which a crash would mean a charge with no record; publishing
retries to narrow it, and fails loudly rather than reporting success if the record never
lands.

**Receipts fit in one HCS chunk.** Messages over 1024 bytes are split across
transactions, and the mirror node REST API does not reassemble them. A size assertion
keeps receipts under the limit so any reader stays simple.

**The buyer's key lives in the buyer's wallet, not in the app.** `apps/wallet` is a
separate process holding the only copy of `BUYER_PRIVATE_KEY`. The demo web server calls
it over loopback with a shared secret and never sees the key, so the thing rendering the
seller's UI is not also the custodian of your funds — stop the wallet and the web server
is simply incapable of spending. The wallet enforces a policy the caller cannot raise:
per-payment ceiling, total budget, allowed assets, allowed recipients. Default is HBAR
only, and a token has to be listed explicitly.

That is the realistic shape for this product's actual user: a buying agent has its own
wallet and does not hand its key to every service it shops at. For a **human** buyer the
same boundary is WalletConnect and a phone.

The half of that which does not need a wallet is built and verified —
`buildUnsignedPayment` and `payloadFromSignedBytes` construct the transaction a wallet
would sign and wrap what it returns, with the fee-payer rule asserted on both sides. A
real quote, a real 402 and a real settlement have gone through that path with a local
signature standing in for the wallet (receipt seq 15). The WalletConnect round trip
itself is **not implemented**, because it needs a project id and a real wallet to
exercise even once, and shipping unexercised signing code into the path that spends a
user's money would be worse than saying so. See
[`docs/WALLETCONNECT.md`](docs/WALLETCONNECT.md) for the seam and what finishing it
takes.

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
