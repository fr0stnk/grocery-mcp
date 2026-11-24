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
