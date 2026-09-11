# The seller, containerised.
#
# ── Why not the official Playwright image ───────────────────────────────────────
# `mcr.microsoft.com/playwright` is the obvious base and was the first choice here. It
# is also ~2GB, because it ships Chromium, Firefox and WebKit together with the system
# libraries for all three. On a small builder that is the difference between a build that
# runs and one that is rejected before it emits a single line of output — which is how
# this failed: three deploys whose entire build log was "scheduling build", while the two
# services on a slim base built and streamed normally.
#
# The worker only ever launches Chromium, so the other two are paid for and never used.
# A slim Node base plus `playwright install chromium` gets the same capability for
# roughly a quarter of the size, and keeps the browser version pinned to the `playwright`
# package in the lockfile rather than to an image tag that has to be kept in step with it
# by hand.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production CI=1

RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig*.json ./
COPY packages ./packages
COPY apps ./apps

# `--prod=false` is stated rather than assumed. This repo starts the seller with `tsx` and
# reaches the Hedera SDK through workspace packages, so a production install that pruned
# devDependencies would build a clean image that dies on boot with "tsx: not found" —
# a failure that reads like a broken CMD rather than a missing install.
#
# pnpm 10 does not in fact prune on NODE_ENV (checked, unlike npm), so this changes
# nothing today. It is here so that an .npmrc, a pnpm upgrade, or a host that injects
# `--prod` cannot quietly turn a deploy into that failure.
RUN pnpm install --frozen-lockfile --prod=false

# Chromium and only Chromium, with its system libraries. `--with-deps` runs apt, so this
# needs root; the container runs as root, which is why nothing is switched away from it.
RUN pnpm exec playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

# Quotes are price commitments; persisting them across restarts means a redeploy does not
# leave a buyer holding a signed payment for a job the seller no longer recognises. Mount
# something durable at /app/.data — `docker run -v`, or a volume on whatever hosts this.
#
# Deliberately *not* a `VOLUME` instruction. Declaring one hands the path to the runtime's
# own volume machinery, and a platform that also wants to manage that mount then has two
# owners for one directory. Railway rejected every deploy of this image at the deploy
# step, before the build produced a line of output, and accepted the identical image with
# this one line removed.
ENV QUOTE_STORE_PATH=/app/.data/quotes.json
ENV PORT=8402
EXPOSE 8402

# No key is baked in. SELLER_PRIVATE_KEY comes from the runtime environment.
#
# The port is read from the environment rather than repeated as a literal: PaaS hosts
# assign one and inject PORT, which overrides the ENV above. A health check pinned to
# 8402 would then probe a port nothing is listening on and report a healthy container as
# dead — a failure that looks like a crash loop and is not one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8402)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "seller"]
