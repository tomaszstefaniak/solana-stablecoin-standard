FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

# Copy source
COPY src ./src

# Build
RUN npm run build

# ─────────────────────────────────────────
# Runtime image
# ─────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files
COPY --from=builder /app/dist ./dist

# Non-root user
RUN addgroup -g 1001 -S sss && adduser -u 1001 -S sss -G sss
USER sss

EXPOSE 3001 3002 3003

# Default: mint service (overridden per-service in docker-compose.yml)
CMD ["node", "dist/mint-service.js"]
