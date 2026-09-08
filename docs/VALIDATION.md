# Validation

The judging rubric weights Validation at 15% and asks for evidence of external user
testing, market feedback cycles, and traction data. This document is deliberately blunt
about which of those exist and which do not.

## What can be proved right now

Every job this service has ever run is recorded on a public, append-only Hedera topic
that the seller cannot edit. That makes usage a *computation over public data* rather
than a claim on a slide. Run it yourself:

```bash
pnpm usage
```

At the time of writing, against topic
[`0.0.10413059`](https://hashscan.io/testnet/topic/0.0.10413059):

```
jobs             14  (13 ok, 1 failed, 93% success)
paying accounts  1
revenue          4477000 tinybar
                 936 WORK
work metered     51 steps, 25 pages, 135s
capabilities
     9  quotes.search_and_extract
     3  govinfo.federal_register_issues
     1  virgo.catalogue_search
     1  books.filter_catalogue
```

**Paying accounts: 1.** That is the developer's own buyer account. There is no external
usage yet, and the instrument says so rather than flattering the number — which is the
main reason to report traction this way. Anyone can recompute these figures from the
same messages, including someone trying to prove they are inflated.

Two design choices in the reader exist to stop it flattering:

- A failed job counts as a job. Excluding failures would inflate the success rate, which
  is the number a sceptical reader is most entitled to distrust.
- A payer is only counted once they have actually been charged. A failed job charges
  zero, so counting its payer would pad the user number with people who paid nothing.

## What is honestly missing

- **No external users.** One account, and it is ours.
- **No market feedback cycles.** Nobody outside the project has used this and told us
  what was wrong with it.
- **No traction beyond testnet.** Every figure above is testnet HBAR and a token we
  minted ourselves. It is real settlement, but it is not revenue.

No amount of code fixes those three. They need people, and the honest position is to say
so rather than dress up self-testing as validation.

## The plan that would fix it

Ordered by how much evidence each produces per hour spent.

**1. Put the demo somewhere a stranger can use it (highest value).**
The verifier already needs no credentials and never contacts the seller, so the strongest
possible artifact is a hosted seller plus a public verifier page. A judge who runs the
verifier against a receipt they did not create *is* an external test, and it leaves a
trace on the topic. Everything needed for this exists; only hosting does not.

**2. Ask five agent developers to buy one job each.**
The target user is someone building an agent that needs web data. The specific ask is
small and concrete: run `pnpm mcp`, point your agent at it, buy one job, tell us whether
the price was legible before you paid. Five responses is enough to find the obvious
problems, and each one shows up as a distinct paying account in `pnpm usage`.

**3. Record what they say, publicly.**
Feedback that lands in a private doc is indistinguishable from feedback that never
happened. The same tamper-evident argument used for receipts applies here — publish
structured feedback to its own topic, separate from receipts, so the record of criticism
is as unfalsifiable as the record of usage. Built; see "The feedback path" below.

**4. Watch the one number that matters.**
Distinct paying accounts. Jobs run is easy to inflate by running jobs; distinct accounts
that paid real money is not.

## Questions worth asking testers

Written down in advance so the answers are not shaped after the fact.

- Before you paid, did you know what the job would cost and why? If not, what was
  missing from the quote?
- Did you verify the receipt? If not, what would have made you bother?
- What did you *want* to buy that the catalogue does not sell?
- Would you rather pay per job or hold a prepaid balance? Why?
- Is the price too high, too low, or unknowable?

## The feedback path (built)

Topic [`0.0.10426203`](https://hashscan.io/testnet/topic/0.0.10426203), created with
**no submit key**. That is the design decision that matters: anyone with a Hedera account
posts directly, so an entry is attributable to *their* account and we cannot edit it,
drop it, or be its only author.

```bash
pnpm feedback post --from "your name" --capability virgo.catalogue_search \
  --price-clear no --verified yes --notes "..."
pnpm feedback read
```

`read` marks anything from an account the project controls as `[self-reported]` and
excludes it from the external count — checked against *every* project account, not just
the seller's. The first entry was posted from the buyer account and briefly counted as
external until that was fixed, which is exactly the flattering mistake the flag exists to
prevent.

Current state: **1 entry, 0 from accounts the project does not control.** An empty topic
and a topic with one self-labelled test entry are both honest; a topic with one
flattering anonymous entry would not be.

[`OUTREACH.md`](OUTREACH.md) has the ask, where to send it, and the questions — written
down before any answers arrive so they are not shaped by what people happen to say.

## Reproducing the figures

```bash
pnpm usage                                    # aggregate over the topic
pnpm usage 0.0.10413059                       # or any other topic
curl "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10413059/messages?limit=100"
```

The aggregation is a pure function (`summariseUsage`) with its own tests, so the maths
can be checked without the network at all.
