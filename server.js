// server.js
const express = require('express');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const app = express();
const port = process.env.PORT || 3000;

const executablePath = process.env.CHROMIUM_PATH || undefined;
const chromiumArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
];

const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '21600', 10);
const MAX_REDIRECT_STEPS = parseInt(process.env.MAX_REDIRECT_STEPS || '20', 10); // анти-цикл по глубине

const db = new Database(process.env.SQLITE_PATH || './cache.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS domain_cache (
  domain TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,     -- JSON массива связанных доменов
  final_url TEXT,
  redirect_chain_json TEXT,      -- JSON журнала редиректов
  updated_at INTEGER NOT NULL,
  ttl_at INTEGER NOT NULL
);
`);

const stmtSelect = db.prepare(`
  SELECT result_json, final_url, redirect_chain_json, updated_at, ttl_at
  FROM domain_cache WHERE domain = ?
`);
const stmtUpsert = db.prepare(`
INSERT INTO domain_cache (domain, result_json, final_url, redirect_chain_json, updated_at, ttl_at)
VALUES (@domain, @result_json, @final_url, @redirect_chain_json, @updated_at, @ttl_at)
ON CONFLICT(domain) DO UPDATE SET
  result_json = excluded.result_json,
  final_url = excluded.final_url,
  redirect_chain_json = excluded.redirect_chain_json,
  updated_at = excluded.updated_at,
  ttl_at = excluded.ttl_at
`);

app.use(express.json());

function extractDomain(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

let browser;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: chromiumArgs,
  });
  return browser;
}

// Вспомогательная функция для сборки полного журнала редиректов через цепочку redirectedFrom()
function buildRedirectChainForResponse(resp) {
  const chain = [];
  const currentReq = resp.request();
  let prev = currentReq.redirectedFrom();
  let toUrl = currentReq.url();
  const status = resp.status();
  while (prev) {
    chain.push({ from: prev.url(), to: toUrl, status });
    toUrl = prev.url();
    prev = prev.redirectedFrom();
  }
  return chain.reverse();
}

async function scanDomainOnce(originDomain) {
  const startUrl = `https://${originDomain}`;

  const b = await getBrowser();
  const context = await b.newContext();
  const page = await context.newPage();

  const seenDomains = new Set();
  const redirectLog = [];
  const visitedUrls = new Set(); // для детекции циклов
  let redirectSteps = 0;

  // Фиксируем все запросы
  page.on('request', req => {
    const d = extractDomain(req.url());
    if (d) seenDomains.add(d);
  });

  // Фиксируем ответы и редиректные цепочки
  page.on('response', resp => {
    const url = resp.url();
    const d = extractDomain(url);
    if (d) seenDomains.add(d);

    // Добавим элементы цепочки, если ответ был редиректом (3xx)
    const status = resp.status();
    if (status >= 300 && status < 400) {
      const piece = buildRedirectChainForResponse(resp);
      redirectLog.push(...piece);
    }
  });

  try {
    let currentUrl = startUrl;
    // Анти-цикл: свой контроль над goto в несколько шагов — через ожидание события navigation и проверку URL
    // Однако Playwright следует редиректам сам; для анти-цикла контролируем уникальность URL после перехода
    const resp = await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // После авто-редиректов Playwright мы проверим фактическую цепочку через обработчики и page.url()

    // Защита от «вечных» редиректов: проверим историю URL в performance entries
    // Простой и надёжный способ: считать шаги смены URL в waitForNavigation с url predicate — но нам достаточно лимита по постфакту.
    // Проверим финальный URL и убедимся, что не было явного зацикливания по уже виденным URL.
    const finalUrl = page.url();
    if (visitedUrls.has(finalUrl)) {
      throw new Error('Redirect loop detected');
    }
    visitedUrls.add(finalUrl);

    // Как дополнительная защита — лимит по шагам 3xx из собранного redirectLog
    // Если цепочка слишком длинная, считаем её небезопасной.
    redirectSteps = redirectLog.length;
    if (redirectSteps > MAX_REDIRECT_STEPS) {
      throw new Error(`Too many redirects (${redirectSteps})`);
    }

    await context.close();

    const relatedDomains = Array.from(seenDomains)
      .filter(d => !d.includes('doubleclick') && !d.includes('google'))
      .sort();

    return {
      finalUrl,
      relatedDomains,
      redirectChain: redirectLog,
    };
  } catch (e) {
    try { await context.close(); } catch {}
    throw e;
  }
}

function getFromCache(domain) {
  const row = stmtSelect.get(domain);
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.ttl_at > now) {
    return {
      relatedDomains: JSON.parse(row.result_json),
      finalUrl: row.final_url || null,
      redirectChain: row.redirect_chain_json ? JSON.parse(row.redirect_chain_json) : [],
      cached: true,
      cachedAt: row.updated_at,
      ttlAt: row.ttl_at,
    };
  }
  return null;
}

function putToCache(domain, result) {
  const now = Math.floor(Date.now() / 1000);
  const ttlAt = now + CACHE_TTL_SECONDS;
  stmtUpsert.run({
    domain,
    result_json: JSON.stringify(result.relatedDomains || []),
    final_url: result.finalUrl || null,
    redirect_chain_json: JSON.stringify(result.redirectChain || []),
    updated_at: now,
    ttl_at: ttlAt,
  });
}

app.get('/domains', async (req, res) => {
  const { domain } = req.query;
  if (!domain) {
    res.status(400).json({ error: '"domain" query parameter is required' });
    return;
  }
  try {
    const cached = getFromCache(domain);
    if (cached) {
      res.json({
        domain,
        finalUrl: cached.finalUrl,
        relatedDomains: cached.relatedDomains,
        redirectChain: cached.redirectChain,
        cached: true,
        cachedAt: cached.cachedAt,
        ttlAt: cached.ttlAt,
      });
      return;
    }

    const result = await scanDomainOnce(domain);
    putToCache(domain, result);

    res.json({
      domain,
      finalUrl: result.finalUrl,
      relatedDomains: result.relatedDomains,
      redirectChain: result.redirectChain,
      cached: false,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

process.on('SIGTERM', async () => {
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});
process.on('SIGINT', async () => {
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Domain scanner service listening on port ${port}`);
});

