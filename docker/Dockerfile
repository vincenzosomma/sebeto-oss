# syntax=docker/dockerfile:1.7
# Sebeto container image: headless sebeto-core serving the web UI on :7600.
# Build from the repo root:   docker build -f docker/Dockerfile -t sebeto .
# With Claude Code CLI:       docker build -f docker/Dockerfile --build-arg INSTALL_CLAUDE=true -t sebeto .

ARG NODE_VERSION=24

# ---------------------------------------------------------------- build
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
# Toolchain for native modules (better-sqlite3) in case no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci
COPY packages ./packages
RUN npm run build -w @sebeto/shared \
    && npm run build -w @sebeto/core \
    && npm run build -w @sebeto/ui

# ---------------------------------------------------------------- production dependencies only
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --omit=dev --workspace @sebeto/core --workspace @sebeto/shared --include-workspace-root=false

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-slim AS runtime
ARG INSTALL_CLAUDE=false
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini git \
    && rm -rf /var/lib/apt/lists/* \
    && if [ "$INSTALL_CLAUDE" = "true" ]; then npm install -g @anthropic-ai/claude-code && npm cache clean --force; fi

ENV NODE_ENV=production \
    SEBETO_HOST=0.0.0.0 \
    SEBETO_PORT=7600 \
    SEBETO_WORKSPACE=/data/workspace \
    SEBETO_UI_DIR=/app/packages/ui/dist

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/ui/dist packages/ui/dist
COPY docker/healthcheck.mjs /app/docker/healthcheck.mjs

RUN mkdir -p /data /workspace && chown -R node:node /data /workspace
USER node
VOLUME ["/data", "/workspace"]
EXPOSE 7600

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]

# Requires SEBETO_TOKEN or SEBETO_TOKEN_FILE: the core refuses to listen on 0.0.0.0 without one.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/core/dist/main.js"]
