# ── Stage 1: build the React frontend ────────────────────────────────────────
FROM node:24-alpine AS ui-builder
RUN apk upgrade --no-cache
WORKDIR /build/ui

# Install UI deps separately so layer is cached
COPY ui/package*.json ./
RUN npm ci

# Copy source and build (output goes to /build/public via vite outDir: ../public)
COPY ui/ ./
RUN npm run build


# ── Stage 2: relay server ─────────────────────────────────────────────────────
FROM node:24-alpine AS relay
RUN apk upgrade --no-cache

# Non-root user
RUN addgroup -S botter && adduser -S botter -G botter
WORKDIR /app

# Install only production deps (no dev/test)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Copy built frontend into public/ so @fastify/static picks it up
COPY --from=ui-builder /build/public ./public

# Ensure data + staging dirs exist and are writable
RUN mkdir -p /data /app/staging_data \
    && chown -R botter:botter /app /data

USER botter

# TCP port (Win98 agents) + HTTP port (web GUI / REST)
EXPOSE 9000 3000

# Allow overriding DB path + staging dir via env; default to persistent volumes
ENV DB_PATH=/data/relay.db \
    STAGING_DIR=/app/staging_data \
    NODE_ENV=production

CMD ["node", "index.js"]
