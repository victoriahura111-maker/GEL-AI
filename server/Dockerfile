# syntax=docker/dockerfile:1
#
# AI Virtual Task Assistant — API server image (Phase 19).
#
# Multi-stage build for the npm-workspaces monorepo. Build from the REPOSITORY
# ROOT so the workspace lockfile and both `package.json` files are in context:
#
#     docker build -f server/Dockerfile -t ai-virtual-task-assistant-api .
#     docker run --env-file .env -p 4000:4000 ai-virtual-task-assistant-api
#
# The SPA is a separate static build (`npm run build -w client` → client/dist)
# and is served by a static host / CDN — it is not part of this image.

# ---------------------------------------------------------------------------
# 1. Install dependencies for every workspace (cached on the lockfile).
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

# ---------------------------------------------------------------------------
# 2. Compile the server TypeScript (tsc → server/dist).
# ---------------------------------------------------------------------------
FROM deps AS build
COPY server ./server
RUN npm run build -w server

# ---------------------------------------------------------------------------
# 3. Drop devDependencies for the runtime image.
# ---------------------------------------------------------------------------
FROM deps AS prod-deps
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# 4. Slim runtime: non-root, production env, health-checked.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Least-privilege runtime user.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs appuser

# Production dependencies + manifests, then the compiled server only.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist

USER appuser
EXPOSE 4000

# Liveness check against the cheap, dependency-free /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/dist/index.js"]
