# Use official Node.js LTS base image
FROM node:20-slim

# Install dependencies for running Chromium
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
COPY ignore-domains.txt ./
RUN npm ci

# Install Playwright browsers (Chromium)
RUN npx playwright install chromium

# Copy app sources
COPY . .

# Expose port
EXPOSE 3000

# Run the service
CMD ["npm", "start"]

