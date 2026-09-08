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

## What is not built

The WalletConnect round trip itself:

```ts
// NOT IMPLEMENTED
const dAppConnector = new DAppConnector(metadata, LedgerId.Testnet, projectId, ...);
const { signedTransaction } = await connector.hedera_signTransaction({
  signerAccountId: buyerAccountId,
  transactionBody: unsigned.bytes,
});
const header = payloadFromSignedBytes(requirements, signedTransaction);
```

`hedera_signTransaction` is the correct method — it collects a signature *without*
executing, which is exactly what x402 needs, since the facilitator submits. The seam is
one function: anything that turns unsigned bytes into signed bytes drops straight in
where the local wallet call sits in `apps/web/src/main.ts`.

**Why it is not implemented rather than half-implemented:** it needs a WalletConnect
project id and a real wallet to exercise even once. Shipping browser signing code that
has never signed anything, into the path that spends a user's money, would be worse than
saying plainly that it is not done. The parts that *could* be verified without a wallet
have been, and they are the parts most likely to be wrong.

## To finish it

1. Get a project id from [reown.com](https://reown.com) (free).
2. `pnpm add @hashgraph/hedera-wallet-connect` in `apps/web`.
3. Add a bundler to `apps/web` — the page is currently plain HTML with no build step, and
   the connector is an npm ESM package. `apps/verify-page/build.mjs` is a working esbuild
   setup to copy.
4. Replace the `signWithWallet` call with the connector call above. Everything either
   side of it already works.
5. Test with a real wallet on testnet before letting anyone near it.

Expect the bundle to grow considerably: the connector pulls in the Hedera SDK, and the
current demo page ships no JavaScript bundle at all.

## Which to use

| | `apps/wallet` | WalletConnect |
| --- | --- | --- |
| Buyer | an agent | a person |
| Key lives | a process the buyer runs | their phone |
| Spend limits | policy the caller cannot raise | whatever the wallet offers |
| Status | working, tested | seam documented, not built |

For an agentic payments product the first row is the one that matters, which is why that
path is the one that works.
