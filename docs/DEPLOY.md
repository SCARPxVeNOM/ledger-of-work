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

### Vercel

`vercel.json` at the repo root is already configured for this — build command, output
directory, and headers. Point Vercel at the repository root, not at `apps/verify-page`:
the build runs from the workspace root because the page imports `@low/protocol` and
`@low/worker` as workspace packages.

```bash
vercel            # preview
vercel --prod     # production
```

Two settings in that file are worth knowing about rather than discovering:

- **`--prod=false` on the install.** Vercel sets `NODE_ENV=production` for builds, and
  the bundler (`esbuild`) is a devDependency. pnpm 10 does not currently prune on
  `NODE_ENV`, so this changes nothing today — it is there so a pnpm upgrade or an
  injected `--prod` cannot turn the build into a "cannot find package esbuild" failure.
- **A restrictive CSP**, because this page is the trust anchor and should be hard to
  turn into a lying one. `connect-src https:` rather than pinning the mirror node,
  because the page deliberately lets a sceptic point it at *their* mirror — pinning ours
  would defeat the purpose of a verifier you are not supposed to trust.

### Anywhere else

The output is plain files. `netlify deploy --dir apps/verify-page/dist`, an S3 bucket, or
a USB stick all work equally well. There is nothing to configure.

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

**Hosts that work without modification:** Railway, Render, Fly.io, or any VM. The
container is around 2 GB because it carries a browser — that is the product working, not
bloat, and a slim Node base would need the whole browser dependency chain added back by
hand.

### Railway

`railway.toml` at the repo root configures the build, the health check and the replica
count. Railway picks it up automatically.

```bash
railway init          # link the repo
railway up            # build and deploy the Dockerfile
```

Then, by hand in the dashboard — neither can be set from the file:

1. **Variables** — `SELLER_ACCOUNT_ID`, `SELLER_PRIVATE_KEY`, `SELLER_TOPIC_ID`, and
   optionally `AGENT_CARD_FILE_ID`, `PAYMENT_TOKEN_ID`, `ZKTLS_OWNER_KEY`. Without the
   last one the service runs fine and simply produces no retrieval proofs; the verifier
   reports that as unproven rather than as fine.
2. **A volume mounted at `/app/.data`.** Skip this and two things break on every
   redeploy: outstanding quotes vanish, so a buyer holding a signed payment gets rejected
   for a job the seller no longer recognises; and the ~26 MB of zero-knowledge circuits
   are re-downloaded on the first proof.

`numReplicas` is pinned to 1 in `railway.toml`, and that is a correctness constraint
rather than a cost one — the reasoning is in the file. Raising it needs the quote store
moved somewhere shared first.

Railway injects its own `PORT`, which overrides the Dockerfile default. The server reads
it, and the container health check reads it too — a check pinned to 8402 would report a
healthy container as dead and look exactly like a crash loop.

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
