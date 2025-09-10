const express = require('express');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3000;

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

  try {
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('request', request => {
      const d = extractDomain(request.url());
      if (d) seenDomains.add(d);
    });

    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await browser.close();

    // Фильтрация доменов
    const filteredDomains = Array.from(seenDomains).filter(d =>
      !d.includes('doubleclick') && !d.includes('google')
    ).sort();

    res.json({ domains: filteredDomains });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Domain scanner service listening on port ${port}`);
});

