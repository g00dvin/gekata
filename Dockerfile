FROM node:20-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /usr/src/app

# Базовые утилиты, без лишних рекоммендованных пакетов
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Ставим только headless shell Chromium и его системные зависимости
RUN npx playwright install --with-deps --only-shell && \
    rm -rf /usr/share/doc /usr/share/man /var/cache/apt/*

# Копируем минимально нужные исходники
COPY server.js ./
# Если используется игнор-лист как файл — раскомментируйте строку:
COPY ignore-domains.txt ./

EXPOSE 3000
CMD ["node", "server.js"]

