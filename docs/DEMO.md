# Demo script

Four minutes, three claims. Everything below runs against Hedera testnet and settles real
payments — nothing is mocked.

## Before you start

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env      # two ECDSA testnet accounts from portal.hedera.com
```

One-time setup, if you want the token and on-chain card legs:

```bash
node scripts/setup-hts.mjs      # creates the WORK token, associates and funds the buyer
pnpm seller &                   # needs to be up for the next one
npx tsx scripts/publish-card.mjs
```

Then, in two terminals:

```bash
pnpm seller     # :8402
pnpm web        # :8403
```

Sanity check before you present: `curl -s localhost:8402/health` should report the
facilitator reachable. If Blocky402's testnet instance is down, say so rather than
improvising — the fallback is a self-hosted facilitator, which is a slower story.

---

## Claim 1 — this is a job, not a fetch (60s)

Open **http://localhost:8403**.

Pick `quotes.search_and_extract`, tag `love`, 3 quotes. **Get a quote.**

> Point at the outline. Four lines: open the login form, submit credentials, open the tag
> page, extract. A single GET cannot produce this — the site wants a session cookie and a
> CSRF token before it will show you anything, and the results are paginated. That is why
> every pay-per-call scraper prices a page fetch and none of them price *this*.

**Pay & run.** The meter prints each step as it happens with the running charge climbing.

> That counter is not a progress bar. It is the same meter that produces the price and
> gets written into the receipt.

## Claim 2 — the price follows the work (45s)

Quote a second job: clear the tag, ask for **100** quotes. Note the quote — around
1,572,000 tinybar against the first job's 312,000.

> Four times the work, five times the price. Same capability, same price book, published
> in the manifest so the buyer could have computed it themselves before asking.

Run it if there is time; the point lands on the quote alone.

## Claim 3 — the delivery is provable (90s)

Back on the first job's receipt. **Verify receipt.**

Ten checks stamp in green, then a VERIFIED stamp.

> Read out the three that matter: the result matches the hash recorded on chain, the
> settlement moved exactly the amount claimed, and the quote follows the published price
> book. This is running against the public mirror node — no credentials, and it never
> asks the seller anything.

Now **Tamper & re-verify.**

> One character of one field changed. Nothing else touched.

Nine checks stay green. The hash check goes red. A VOID stamp lands on the receipt.

> The payment still settled. The price is still honest. The receipt is still on the topic.
> The only thing that broke is the tie between the receipt and this particular answer —
> which is the whole product. The seller cannot quietly substitute a different result
> after the fact.

Open the HashScan link on the receipt to show the message is really there.

---

## If you have another minute

**Any agent can buy this.** `pnpm mcp` speaks MCP over stdio: `list_capabilities` reads
the manifest live, `quote_job` prices for free, `buy_job` pays. `buy_job` takes a
`maxTinybar` ceiling and refuses above it — an autonomous agent holding a wallet should
not settle a price it did not expect.

**Pay in a stablecoin instead of HBAR.**

```bash
pnpm buy --capability quotes.search_and_extract --asset 0.0.10416991 \
  --param tag=love --param max=3 --out ./result-hts.json
```

Same job, settled in an HTS token at the rate published in the manifest.

**The catalogue is on chain too.** `AGENT_CARD_FILE_ID` points at the manifest published
to Hedera File Service, so a buyer can check the price book they were quoted against the
one the seller committed to publicly — rather than reading it from the same server that
produced the receipt, which would be circular.

**Verify from a clean checkout**, to make the point that it needs nothing of ours:

```bash
pnpm verify --topic 0.0.10413059 --seq 6 --result ./result.json \
  --capability quotes.search_and_extract --submitter 0.0.10410493
```

Exit code 0 on success, 1 on failure — it works in CI.

---

## Questions you will get

**"Isn't this just a scraper with extra steps?"**
The scrapers in this category price a page fetch and hand you bytes. This prices the work
and hands you bytes plus a record that anyone can check. Those are different products;
the second one is buyable by an agent that has no reason to trust you.

**"Why not just use the `upto` scheme for metering?"**
`upto` is specified against Permit2 and ships on EVM networks only. Every Hedera network
offers `exact`. So the meter quotes from a plan and settles once for a work-derived
price. Saying "upto on Hedera" would be wrong and we do not say it.

**"What stops you inflating the price?"**
The price book is published, the plan the quote was priced from is in the receipt, and
the verifier recomputes the quote from both. A price that does not follow the book fails
check eight.

**"What if the job costs more than you quoted?"**
The seller absorbs it. `exact` gives no way to charge more after the buyer has signed.
The receipt records the plan and the actual work side by side, so the absorption is
visible rather than something we can pocket.

**"What if a job fails?"**
Nothing settles, and a `failed` receipt is still published. A log that only records
successes proves nothing.

## Known limits — say these before a judge finds them

- Quotes are held in memory, so a seller restart drops open ones.
- The demo server holds the buyer's key. A real buyer would sign in their own wallet;
  putting a private key in browser JavaScript would have been the wrong lesson.
- One capability runs against sandboxes built for scraping. The adapter interface is the
  deliverable; a real site is a week-one decision that has not been made yet.
- HFS file *contents* are not exposed over the mirror REST API, so reading the agent card
  needs an account. The receipt path has no such limitation.
