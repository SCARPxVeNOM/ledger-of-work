# Signing in your own wallet

The buyer's key never belongs in the seller's demo. Today it lives in
[`apps/wallet`](../apps/wallet), a separate process the buyer runs with its own spend
policy — which is the right shape for this product's actual user, an agent with its own
wallet. For a **human** buyer the same boundary is WalletConnect and a phone.

This document is precise about what is built and what is not, because the difference
matters and is easy to blur.

## What is built and verified

The half of wallet signing that does not need a wallet:

```ts
import { buildUnsignedPayment, payloadFromSignedBytes } from "@low/buyer-cli";

const unsigned = buildUnsignedPayment(requirements, buyerAccountId);
//   -> { bytes, transactionId }   frozen, unsigned, ready for any signer

const header = payloadFromSignedBytes(requirements, signedBytes);
//   -> base64 x402 payload for the PAYMENT-SIGNATURE header
```

`buildUnsignedPayment` is where the scheme's sharpest rule lives:
`transactionId.accountId` must be the **facilitator's fee payer**, not the buyer. Getting
that wrong yields an opaque `InvalidSignature` with no clue as to why, so it is asserted
directly. `payloadFromSignedBytes` re-checks the same thing on the way out, where the
error message can still name the problem.

Verified end to end by [`scripts/spike-wallet-path.mjs`](../scripts/spike-wallet-path.mjs):
a real quote, a real 402, unsigned bytes built by this code, signed locally in place of a
wallet, wrapped, and settled through the real facilitator — receipt seq 15 on topic
`0.0.10413059`. Eleven unit tests cover construction, including that transfers net to
zero and that a token payment moves no HBAR.

## What is now built

The round trip, in [`apps/web/src/connect.ts`](../apps/web/src/connect.ts) and two server
endpoints. `hedera_signTransaction` is the method, because it collects a signature
*without* executing — which is what x402 needs, since the facilitator submits.

It is split across two requests rather than one, because a wallet signature happens on
someone's phone and that is a human-scale pause to hold an HTTP request open for:

- `POST /api/pay/prepare` fetches the 402, builds the unsigned payment against the
  connected account, and returns bytes plus an opaque `payId`.
- `POST /api/pay/complete` takes the signature back, wraps it, and runs the job.

The requirements stay on the server between the two. The browser never sends back a
description of what it is paying for — otherwise `complete` would wrap whatever it was
handed, which makes the demo server a relay for arbitrary signed transactions.

### The bug this nearly shipped with

The connector pins `@hiero-ledger/sdk` to **exactly 2.79.0** as a peer dependency, while
this workspace is on 2.87.0, so pnpm installed both. Inside `signTransaction` there is an
`instanceof Transaction` check against *its* copy — so a transaction built with ours
would have failed it and thrown `Transaction sent in incorrect format`, for every
signature, forever.

A `pnpm.overrides` entry forces one copy. The check that catches a regression is in
`.data`-free form: ask the bundle to sign with no wallet attached and read which error
comes back. `No signer found for account …` means the transaction was rebuilt and
accepted; `incorrect format` means the two SDKs are back.

### What is still not verified

**Nobody has signed anything with a real wallet.** Everything up to the wallet is
exercised — the bundle loads, initialises, reaches the relay, rebuilds the server's
unsigned bytes and satisfies the format check — but the tap-to-approve and what comes
back from it have not been seen. Test on testnet with a real wallet before pointing
anyone at it.

The bundle is **3.7 MB**: the Hedera SDK, WalletConnect and ethers. It is loaded on click
rather than on page load, so reading a receipt does not download a wallet stack.

## Which to use

| | `apps/wallet` | WalletConnect |
| --- | --- | --- |
| Buyer | an agent | a person |
| Key lives | a process the buyer runs | their phone |
| Spend limits | policy the caller cannot raise | whatever the wallet offers |
| Status | working, tested | built; unsigned by a real wallet |

For an agentic payments product the first row is the one that matters, which is why that
path is the one that works.
