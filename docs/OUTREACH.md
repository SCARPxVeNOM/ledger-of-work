# Getting five external testers

The goal is five people who are not us buying one job each. That is the smallest number
that finds the obvious problems, and it is the only thing that moves
[Validation](VALIDATION.md) off zero.

## The ask, in one message

Keep it small and concrete. "Try my project" gets ignored; "spend four minutes and one
cent" does not.

> **Subject / opener**
>
> I built a thing that sells *completed web work* to agents rather than page fetches —
> you submit a job, it drives a real browser, and it charges for the steps it actually
> took. Every job leaves a receipt on Hedera that you can verify without trusting me.
>
> Would you spend four minutes buying one job? It costs about 0.004 testnet HBAR.
>
> `npx ...` / repo: https://github.com/SCARPxVeNOM/ledger-of-work
>
> The one thing I want to know: **before you paid, did you know what it would cost and
> why?**

Ask one question, not five. The rest are on the form if they want them.

## Where these people are

Ranked by how likely a reply is.

1. **Anyone else in the hackathon building an agent.** They have a testnet account
   already, which removes the largest single obstacle. Trade: offer to test theirs.
2. **The Hedera Discord** (`hedera.com/discord`), in the x402 or dev channels. Post what
   it does and the one question, not a wall of text.
3. **People who have shipped an x402 endpoint.** They will have opinions about pricing
   specifically, which is the part least likely to survive contact with a stranger.
4. **Anyone building browser-using agents** — they have felt the "there is no API for
   this" problem directly and will know instantly whether the framing is right.

## Make it cost them as little as possible

The friction is not the software, it is the setup. In order of what actually blocks
people:

- **A funded testnet account.** Unavoidable, but say up front it takes two minutes at
  [portal.hedera.com](https://portal.hedera.com) and is free.
- **Cloning and installing.** If the seller is hosted
  ([DEPLOY.md](DEPLOY.md)), they only need `apps/buyer-cli`, not the browser stack.
- **Not knowing what to do.** Give the exact command with the parameters filled in, not
  a description of the command.

If someone will not install anything at all, the hosted verifier still works: send them a
receipt link and the result file, and ask whether they believe it. That is a smaller test
but it is not nothing.

## Leaving feedback

The feedback topic has **no submit key**, so a tester posts from their own account and
the entry is attributable to them — we cannot edit it, drop it, or be the only author on
it.

```bash
pnpm feedback post --from "your name" \
  --capability virgo.catalogue_search \
  --price-clear no --verified yes \
  --notes "the outline made the price make sense, but I did not know what a step was"
```

```bash
pnpm feedback read      # entries posted by accounts the project does not control
```

`pnpm feedback read` marks anything posted from our own accounts as `[self-reported]` and
excludes it from the external count. The first entry on the topic is exactly that — a
self-test, labelled as one — because a topic with one flattering anonymous entry proves
less than an empty one.

If a tester will not touch a wallet to leave feedback, take it however they will give it
and post it yourself **with their name in `from` and the entry still marked
self-reported by the account it came from**. Do not post it as though it arrived
independently.

## What to actually ask

Written down before any answers arrive, so the questions are not shaped by what people
happen to say.

1. Before you paid, did you know what it would cost and why? If not, what was missing?
2. Did you verify the receipt? If not, what would have made you bother?
3. What did you *want* to buy that the catalogue does not sell?
4. Pay per job, or hold a prepaid balance? Why?
5. Is the price too high, too low, or unknowable?

Question 3 is the most valuable and the one people answer most willingly.

## What counts as success

Not five polite yeses. Five people who tried it, of whom some say it was confusing — and
`pnpm usage` showing **distinct paying accounts above one**. That number is the hard one
to fake: jobs run is trivially inflated by running jobs, distinct funded accounts that
paid is not.
