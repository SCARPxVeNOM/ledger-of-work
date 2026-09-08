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
RUN pnpm install --frozen-lockfile

# Quotes are price commitments; persisting them across restarts means a redeploy does not
# leave a buyer holding a signed payment for a job the seller no longer recognises.
VOLUME /app/.data
ENV QUOTE_STORE_PATH=/app/.data/quotes.json
ENV PORT=8402
EXPOSE 8402

# No key is baked in. SELLER_PRIVATE_KEY comes from the runtime environment.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:8402/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "seller"]
