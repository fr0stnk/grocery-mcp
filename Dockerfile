FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN install -d -m 0700 -o node -g node /data

FROM base AS rami-build
COPY upstream/rami-levy-mcp/package*.json upstream/rami-levy-mcp/tsconfig.json ./
COPY upstream/rami-levy-mcp/src ./src
# The upstream prepare script compiles the TypeScript server.
RUN npm ci && npm prune --omit=dev --ignore-scripts

FROM base AS rami-levy
COPY --from=rami-build /app/package.json ./
COPY --from=rami-build /app/dist ./dist
COPY --from=rami-build /app/node_modules ./node_modules
COPY upstream/rami-levy-mcp/LICENSE ./
ENV RAMI_LEVY_DB_PATH=/data/cart.db
USER node
CMD ["node", "dist/index.js"]

FROM base AS shufersal
COPY --chown=node:node upstream/shufersal-cart/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node upstream/shufersal-cart/LICENSE upstream/shufersal-cart/tsconfig.json ./
COPY --chown=node:node upstream/shufersal-cart/bin ./bin
COPY --chown=node:node upstream/shufersal-cart/src ./src
ENV SHUFERSAL_COOKIE_FILE=/data/cookies.json \
    SHUFERSAL_CHOICES_FILE=/data/choices.json
USER node
CMD ["node", "bin/shufersal-mcp.mjs"]

FROM base AS server-deps
COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# One server that runs both adapters as child processes. Paths mirror the
# repository so the server's default adapter locations work unchanged.
FROM base AS grocery
COPY --from=rami-levy /app /app/upstream/rami-levy-mcp
COPY --from=shufersal --chown=node:node /app /app/upstream/shufersal-cart
COPY --from=server-deps /app/node_modules /app/server/node_modules
COPY --chown=node:node server/package.json /app/server/
COPY --chown=node:node server/src /app/server/src
RUN install -d -m 0700 -o node -g node /data/rami-levy /data/shufersal /data/grocery
# Set by CI and reported by server_info, serverInfo and /health. Kept last so
# they do not invalidate the cached layers above.
ARG GROCERY_COMMIT=""
ARG GROCERY_BUILD_DATE=""
ARG GROCERY_UPSTREAM_RAMI_LEVY=""
ARG GROCERY_UPSTREAM_SHUFERSAL=""
ENV GROCERY_COMMIT=$GROCERY_COMMIT \
    GROCERY_BUILD_DATE=$GROCERY_BUILD_DATE \
    GROCERY_UPSTREAM_RAMI_LEVY=$GROCERY_UPSTREAM_RAMI_LEVY \
    GROCERY_UPSTREAM_SHUFERSAL=$GROCERY_UPSTREAM_SHUFERSAL \
    GROCERY_DATA_DIR=/data/grocery \
    RAMI_LEVY_DB_PATH=/data/rami-levy/cart.db \
    SHUFERSAL_COOKIE_FILE=/data/shufersal/cookies.json \
    SHUFERSAL_CHOICES_FILE=/data/shufersal/choices.json
USER node
WORKDIR /app/server
CMD ["node", "src/index.js"]

# Runs OpenAI's tunnel-client, which is mounted at runtime and needs the
# system CA bundle for its outbound TLS connection.
FROM debian:bookworm-slim AS tunnel
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
ENTRYPOINT ["/opt/tunnel-client"]
