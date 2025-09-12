// server.js (hardened)
const express = require('express');
const rateLimit = require('express-rate-limit');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const punycode = require('punycode/');

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || undefined;
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '21600', 10);
const MAX_REDIRECT_STEPS = parseInt(process.env.MAX_REDIRECT_STEPS || '20', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const SQLITE_PATH = process.env.SQLITE_PATH || './cache.db';
const MAX_DOMAINS = parseInt(process.env.MAX_DOMAINS || '5000', 10);
const MAX_REDIRECT_LOG = parseInt(process.env.MAX_REDIRECT_LOG || '50', 10);
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '30000', 10);
const QUIET_WINDOW_MS = parseInt(process.env.QUIET_WINDOW_MS || '600', 10); // «маленькая тишина»

const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // рекомендуется заменить на --ipc=host при запуске контейнера
  '--disable-gpu',
  '--no-zygote',
];

// ---------- Helpers ----------
const app = express();
app.use(express.json());

// Basic rate limit (per-IP)
const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Normalize/validate domain
function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  // запрет схем/путей — ожидается чистый host
  try {
    // Если пришёл URL, извлечь hostname
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.hostname;
    // IDNA -> ASCII
    const ascii = punycode.toASCII(host);
    if (!ascii || ascii.length > 253) return null;
    return ascii;
  } catch {
    // Попытка интерпретации как host напрямую
    try {
      const ascii = punycode.toASCII(s);
      return ascii || null;
    } catch {
      return null;
    }
  }
}

function extractDomain(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

// ---------- Simple semaphore ----------
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  acquire() {
    return new Promise(resolve => {
      const tryAcquire = () => {
        if (this.active < this.limit) {
          this.active++;
          resolve(() => {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
          });
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}
const sem = new Semaphore(CONCURRENCY);

// ---------- DB ----------
const db = new Database(SQLITE_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS domain_cache (
  domain TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  final_url TEXT,
  redirect_chain_json TEXT,
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

// ---------- Browser lifecycle ----------
let browser;
async function ensureBrowser() {
  try {
    if (browser && browser.isConnected()) return browser;
  } catch {}
  if (browser) {
    try { await browser.close(); } catch {}
  }
  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: CHROMIUM_ARGS,
  });
  return browser;
}

// ---------- Redirect utilities ----------
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
    if (chain.length >= MAX_REDIRECT_LOG) break;
  }
  return chain.reverse();
}

// ---------- Core scan ----------
async function scanDomainOnce(originDomain, signal) {
  const startUrl = `https://${originDomain}`;
  const b = await ensureBrowser();
  const context = await b.newContext();
  const page = await context.newPage();

  const seenDomains = new Set();
  const redirectLog = [];
  const visitedUrls = new Set();
  const seenPairs = new Set(); // from|to для детекции петель

  // Бюджеты
  let droppedDomains = 0;

  // Capture network
  // Lightweight counter для «тихого» окна
  let inflight = 0;
  let lastNetChange = Date.now();

  const onReq = req => {
    inflight++;
    lastNetChange = Date.now();
    const d = extractDomain(req.url());
    if (d) {
      if (seenDomains.size < MAX_DOMAINS) seenDomains.add(d);
      else droppedDomains++;
    }
  };
  const onResp = resp => {
    inflight = Math.max(0, inflight - 1);
    lastNetChange = Date.now();
    const url = resp.url();
    const d = extractDomain(url);
    if (d) {
      if (seenDomains.size < MAX_DOMAINS) seenDomains.add(d);
      else droppedDomains++;
    }
    const status = resp.status();
    if (status >= 300 && status < 400) {
      const piece = buildRedirectChainForResponse(resp);
      for (const p of piece) {
        if (redirectLog.length >= MAX_REDIRECT_LOG) break;
        const key = `${p.from}|${p.to}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          redirectLog.push(p);
        } else {
          // петля
          // ничего не делаем здесь — оценим ниже общим правилом
        }
      }
    }
  };

  page.on('request', onReq);
  page.on('response', onResp);

  try {
    // Навигация: domcontentloaded, затем дождаться короткой «тишины»
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Простейшее ожидание «тишины» сети, но с общим таймаутом
    const startWait = Date.now();
    while (Date.now() - startWait < NAV_TIMEOUT_MS) {
      if (signal?.aborted) throw new Error('Aborted');
      const quietFor = Date.now() - lastNetChange;
      if (inflight === 0 && quietFor >= QUIET_WINDOW_MS) break;
      await new Promise(r => setTimeout(r, 100));
    }

    const finalUrl = page.url();
    // Анти-цикл: повтор URL или превышение лимита шагов/пар
    if (visitedUrls.has(finalUrl)) throw new Error('Redirect loop detected');
    visitedUrls.add(finalUrl);

    const steps = redirectLog.length;
    if (steps > MAX_REDIRECT_STEPS) throw new Error(`Too many redirects (${steps})`);

    await context.close();

    // Фильтрация и ограничение объёма
    const filteredDomains = Array.from(seenDomains)
      .filter(d => !d.includes('doubleclick') && !d.includes('google'))
      .sort();

    return {
      finalUrl,
      relatedDomains: filteredDomains,
      redirectChain: redirectLog,
      droppedDomains,
    };
  } catch (e) {
    try { await context.close(); } catch {}
    // Если браузер умер — перезапустим на следующем вызове
    try { if (browser && !browser.isConnected()) { await browser.close(); browser = null; } } catch {}
    throw e;
  } finally {
    page.off('request', onReq);
    page.off('response', onResp);
  }
}

// ---------- Routes ----------
app.get('/domains', async (req, res) => {
  const norm = normalizeDomain(req.query.domain);
  if (!norm) {
    res.status(400).json({ error: '"domain" must be a valid hostname' });
    return;
  }

  // Семафор — ограничиваем параллельность
  const release = await sem.acquire();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), NAV_TIMEOUT_MS * 2); // общий верхний потолок

  try {
    const cached = getFromCache(norm);
    if (cached) {
      res.json({
        domain: norm,
        finalUrl: cached.finalUrl,
        relatedDomains: cached.relatedDomains,
        redirectChain: cached.redirectChain,
        cached: true,
        cachedAt: cached.cachedAt,
        ttlAt: cached.ttlAt,
      });
      return;
    }

    const result = await scanDomainOnce(norm, ac.signal);
    putToCache(norm, result);

    res.json({
      domain: norm,
      finalUrl: result.finalUrl,
      relatedDomains: result.relatedDomains,
      redirectChain: result.redirectChain,
      cached: false,
      droppedDomains: result.droppedDomains,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal server error' });
  } finally {
    clearTimeout(timer);
    release();
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Shutdown ----------
process.on('SIGTERM', async () => {
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});
process.on('SIGINT', async () => {
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Domain scanner service listening on port ${PORT}`);
});

