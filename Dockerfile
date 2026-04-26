# syntax=docker/dockerfile:1
#
# companies-house-mcp — production image for Fly.io (or any Docker host).
#
# Two-stage build:
#   1. builder: install all deps, compile TypeScript -> dist/
#   2. runtime: install only production deps, copy in dist/
#
# Resulting image is small and never ships dev-only deps.
#
# Runtime invocation:
#   node packages/cli/dist/server/index.js --http --port 8080
#
# The server reads:
#   COMPANIES_HOUSE_API_KEY  (required)
#   MCP_BEARER_TOKEN         (recommended — required if exposed publicly)
#   PORT                     (NOT used directly — port is passed via --port
#                             in CMD; change there if you want a different one)

# ---------- Stage 1: builder ----------
FROM node:20-alpine AS builder

# Enable pnpm via corepack (built in to recent Node images).
RUN corepack enable

WORKDIR /app

# Copy manifests first so the dependency layer caches when only source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/mcp/package.json ./packages/mcp/

# Install full deps (incl. dev) for the build step.
RUN pnpm install --frozen-lockfile

# Copy the rest of the source and build.
COPY packages ./packages
COPY tsconfig*.json ./
RUN pnpm build

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

RUN corepack enable

WORKDIR /app

ENV NODE_ENV=production

# Re-install with --prod so node_modules contains only runtime deps.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/mcp/package.json ./packages/mcp/
RUN pnpm install --prod --frozen-lockfile

# Copy built dist/ folders from the builder stage.
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/mcp/dist ./packages/mcp/dist

# Document the listening port. Fly.io reads internal_port from fly.toml,
# but EXPOSE is good practice and helps when running locally with docker.
EXPOSE 8080

# Note: the server's --port flag controls the actual listen port.
# Bind via npm-style arg list so signal handling works (no shell wrapper).
CMD ["node", "packages/cli/dist/server/index.js", "--http", "--port", "8080"]
