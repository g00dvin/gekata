// server.js
const express = require('express');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3000;

// Использовать системный Chromium, если задан путь (например, /usr/bin/chromium в Debian)
const executablePath = process.env.CHROMIUM_PATH || undefined; // можно оставить undefined, если Chromium в PATH [1][2]

// Базовый набор флагов для контейнера без systemd/dbus и без install-deps
const chromiumArgs = [
  '--no-sandbox',                // запуск без setuid sandbox в контейнере [14]
  '--disable-setuid-sandbox',    // отключение setuid sandbox [14]
  '--disable-dev-shm-usage',     // использовать /tmp вместо /dev/shm (если нет --ipc=host) [15][16]
  '--disable-gpu',               // headless окружение [14]
  '--no-zygote',                 // упрощение процессов в контейнере [14]
];

app.use(express.json());

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

app.get('/domains', async (req, res) => {
  const { domain } = req.query;
  if (!domain) {
    res.status(400).json({ error: '"domain" query parameter is required' });
    return;
  }

  const url = `https://${domain}`;
  const seenDomains = new Set();
  let browser;
  let context;

  try {
    browser = await chromium.launch({
      executablePath,            // берётся из CHROMIUM_PATH при наличии [1][2]
      headless: true,            // явный headless режим для контейнера [14]
      args: chromiumArgs,        // флаги для стабильности в Docker [15][14]
    });

    context = await browser.newContext();
    const page = await context.newPage();

    page.on('request', request => {
      const d = extractDomain(request.url());
      if (d) seenDomains.add(d);
    });

    await page.goto(url, { waitUntil: 'load', timeout: 30000 });

    // Фильтрация доменов после закрытия страницы
    await context.close();
    await browser.close();

    const filteredDomains = Array.from(seenDomains)
      .filter(d => !d.includes('doubleclick') && !d.includes('google'))
      .sort();

    res.json({ domains: filteredDomains });
  } catch (e) {
    // Безопасно закрыть ресурсы при ошибке
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Domain scanner service listening on port ${port}`);
});

