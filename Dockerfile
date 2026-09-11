# The seller, containerised.
#
# Playwright's image is the base because the worker drives a real browser — that is the
# product, not an implementation detail, and a slim Node image would need the whole
# browser dependency chain added back by hand.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

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

# Quotes are price commitments; persisting them across restarts means a redeploy does not
# leave a buyer holding a signed payment for a job the seller no longer recognises.
VOLUME /app/.data
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
