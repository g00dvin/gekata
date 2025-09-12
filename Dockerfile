# -------- Builder stage --------
FROM debian:bookworm-slim AS builder
ENV DEBIAN_FRONTEND=noninteractive

# Node + build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    nodejs npm \
    python3 make g++ pkg-config libsqlite3-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only manifests first to leverage Docker cache
COPY package*.json ./

# Install production deps (build native modules here)
ENV CI=true
RUN npm ci --omit=dev

# Copy source
COPY . .

# -------- Runtime stage --------
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive

# Install tini for proper PID 1 and signal handling
# Install Node.js runtime, Chromium and minimal libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    tini \
    nodejs npm \
    chromium \
    libx11-6 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
    libgtk-3-0 libnss3 libdrm2 libgbm1 libasound2 fonts-liberation \
    fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules and app from builder
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package*.json /app/
COPY . .

# Security: drop root
RUN useradd -ms /bin/bash nodeuser && chown -R nodeuser:nodeuser /app
USER nodeuser

# Environment
ENV PORT=3000 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=0 \
    CHROMIUM_PATH=/usr/bin/chromium \
    CACHE_TTL_SECONDS=21600

EXPOSE 3000

# Use tini as PID 1 so we don't need `--init`
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the service
CMD ["node", "server.js"]

