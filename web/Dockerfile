# ─────────────────────────────────────────────────────────────
# Production image for the recall Next.js BFF (standalone output).
# Local dev uses Dockerfile.dev (next dev); this image is for Azure
# Container Apps. next.config.ts sets output:"standalone", so the build
# emits a self-contained server bundle we run with `node server.js`.
# ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

# Install exactly what the lockfile pins for a reproducible build.
COPY package.json package-lock.json* ./
RUN npm ci

# Build. `mkdir -p public` guarantees the dir exists for the COPY below
# even though the repo has no public/ assets yet.
COPY . .
RUN mkdir -p public && npm run build

# ─── Runtime ─────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run unprivileged.
USER node

# Standalone output ships a minimal node_modules + server.js; static assets
# and public/ are copied alongside it.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
