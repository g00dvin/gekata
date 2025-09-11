# Base minimal Debian
FROM debian:bookworm-slim

# Prevent tzdata prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js, Chromium and minimal runtime libs
# Note: chromium package on Debian provides /usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    nodejs npm \
    chromium \
    # Minimal GUI/Chromium runtime libs often needed by Playwright Chromium
    libx11-6 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
    libgtk-3-0 libnss3 libdrm2 libgbm1 libasound2 fonts-liberation \
    # Useful for font rendering
    fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# App directory
WORKDIR /app

# Install only production deps
COPY package*.json ./
ENV CI=true
RUN npm ci --omit=dev

# Copy source
COPY . .

# Security: run as non-root
RUN useradd -ms /bin/bash nodeuser && chown -R nodeuser:nodeuser /app
USER nodeuser

# Environment for service
ENV PORT=3000 \
    # Ensure Playwright uses system Chromium and does not download browsers
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=0 \
    # Explicit executable if needed in code; here server uses default, so optional
    CHROMIUM_PATH=/usr/bin/chromium

# Expose service port
EXPOSE 3000

# Start the service
CMD ["node", "server.js"]

