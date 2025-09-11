FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /usr/src/app

COPY package*.json ./
COPY ignore-domains.txt ./

RUN npm ci --omit=dev
RUN npx playwright install chromium

COPY . .

RUN rm -rf /usr/local/share/doc /usr/local/share/man /usr/local/share/info

EXPOSE 3000

CMD ["npm", "start"]

