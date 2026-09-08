# Deploying

Two things can be hosted, and they have very different requirements. The verifier is the
one worth hosting first.

## 1. The verifier — static, free, no secrets

`apps/verify-page` builds to a folder of static files. It reads the public Hedera mirror
node straight from the browser, so it needs no backend, no account, and no key. That is
what makes it worth hosting first: it is the only artifact a stranger can use with zero
setup, and a judge running it against a receipt they did not create is itself the
external test that [`VALIDATION.md`](VALIDATION.md) says is missing.

```bash
pnpm --filter @low/verify-page build     # -> apps/verify-page/dist  (~8 KB bundle)
pnpm --filter @low/verify-page serve     # local preview on :8405
```

### GitHub Pages

`.github/workflows/verify-page.yml` builds and publishes on every push to `main`. It
needs Pages switched on once, by hand:

> **Repository → Settings → Pages → Build and deployment → Source: GitHub Actions**

Then push, or run the workflow manually from the Actions tab. The URL appears in the
workflow summary and is typically
`https://scarpxvenom.github.io/ledger-of-work/`.

The workflow runs `pnpm test` before publishing. That is deliberate rather than
ceremonial: the page embeds published price books, and if those ever drift from what the
seller actually charges, the meter check would verify against a price nobody paid. A test
catches that, and it runs before anything ships.

### Anywhere else

The output is plain files. `netlify deploy --dir apps/verify-page/dist`,
`vercel deploy apps/verify-page/dist`, an S3 bucket, or a USB stick all work equally
well. There is nothing to configure.

### Sharing a receipt

The page reads its fields from the query string, so a receipt is a link:

```
?topic=0.0.10413059&seq=14&submitter=0.0.10410493&capability=virgo.catalogue_search
```

The recipient still supplies the result file themselves, which is the point — the page
never sees anything the seller controls.

## 2. The seller — needs a host, a key, and a funded account

Harder, because it drives a real browser and holds the seller's key.

```bash
docker build -t ledger-of-work .
docker run -p 8402:8402 \
  -e SELLER_ACCOUNT_ID=0.0.x \
  -e SELLER_PRIVATE_KEY=... \
  -e SELLER_TOPIC_ID=0.0.y \
  -e AGENT_CARD_FILE_ID=0.0.z \
  -e PAYMENT_TOKEN_ID=0.0.w \
  -v lowdata:/app/.data \
  ledger-of-work
```

No key is baked into the image; everything comes from the runtime environment. The
volume matters: quotes are price commitments, and without it a redeploy leaves a buyer
holding a signed payment for a job the seller no longer recognises.

**Hosts that work without modification:** Fly.io, Railway, Render, or any VM. The
container is around 2 GB because it carries a browser — that is the product working, not
bloat, and a slim Node base would need the whole browser dependency chain added back by
hand.

**Before pointing anyone at it:**

- Fund the seller account. Receipts cost a fraction of a cent each but they are not free.
- Check `GET /health` reports the facilitator reachable.
- Decide whether to expose the demo UI. It calls a wallet process for signing; on a
  public host you almost certainly want the seller only, and let people bring their own
  buyer via `pnpm buy` or `pnpm mcp`.

**Do not host the wallet.** `apps/wallet` holds a private key and binds to loopback for
that reason. It belongs on the buyer's machine, not on a server. Its spend policy limits
the damage if it is ever reached, but the correct exposure is none.

## What hosting unlocks

Ranked by what it does for the submission:

1. **Verifier on Pages** — a stranger can check any receipt in about thirty seconds.
   Free, no secrets, and it is the claim the whole project rests on.
2. **Seller on a small VM** — someone can buy a job without cloning anything. Needs a
   funded account, so it costs a little and wants watching.
3. **Demo UI** — nice for a video, but the video will already exist, and it is the piece
   with a key-holding dependency.
