// server.js
const express = require('express');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const punycode = require('punycode/');
const app = express();

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || undefined;
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '21600', 10);
// Важно: это реальный лимит редиректов для документной навигации
const MAX_REDIRECT_STEPS = parseInt(process.env.MAX_REDIRECT_STEPS || '20', 10);
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '30000', 10);
const QUIET_WINDOW_MS = parseInt(process.env.QUIET_WINDOW_MS || '700', 10);
const PRECHECK_MAX_REDIRECTS = parseInt(process.env.PRECHECK_MAX_REDIRECTS || '15', 10);
const SQLITE_PATH = process.env.SQLITE_PATH || './cache.db';
const DEBUG_ENABLED = String(process.env.DEBUG || '').trim() === '1';
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
];

// ---------- Logging ----------
const log = {
  info: (...a) => console.log(...a),
  debug: (...a) => { if (DEBUG_ENABLED) console.log(...a); },
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

// ---------- DB ----------
log.info(`[BOOT] SQLite path: ${SQLITE_PATH}`);
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

app.use(express.json());

// ---------- Helpers ----------
function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return punycode.toASCII(u.hostname) || null;
  } catch {
    try { return punycode.toASCII(s) || null; } catch { return null; }
  }
} // [Express/Node JSON response patterns] [4]

function extractDomain(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

// эвристика «выглядит как файл»
function looksLikeFilePath(u) {
  try {
    const { pathname } = new URL(u);
    return /\.(?:zip|pdf|png|jpe?g|gif|webp|svg|mp4|mp3|wav|csv|xlsx?|docx?|pptx?|exe|deb|rpm|apk|tar(?:\.gz)?|7z|gz|bz2)$/i.test(pathname);
  } catch { return false; }
}

// канонизация URL для детекции петель
function normalizeUrlForLoop(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.toString();
  } catch { return u; }
}

// ---------- Precheck: manual redirects & classification ----------
async function precheckFollowManually(startUrl) {
  let url = startUrl;
  const visited = new Set();
  let sawHtmlHint = false;
  for (let i = 0; i < PRECHECK_MAX_REDIRECTS; i++) {
    const norm = normalizeUrlForLoop(url);
    if (visited.has(norm)) {
      log.debug(`[PRECHECK] Loop at ${norm}`);
      return { skip: true, reason: 'redirect-loop', tryBrowser: sawHtmlHint };
    }
    visited.add(norm);
    let res;
    try {
      res = await fetch(url, { method: 'GET', redirect: 'manual' });
    } catch (e) {
      log.debug(`[PRECHECK] GET(manual) failed for ${url}: ${e?.message}`);
      return { skip: false, reason: null, tryBrowser: false };
    }
    const status = res.status;
    const ct = res.headers.get('content-type') || '';
    const cd = res.headers.get('content-disposition') || '';
    const loc = res.headers.get('location') || '';
    log.debug(`[PRECHECK] step=${i} status=${status} ct="${ct}" cd="${cd || '-'}" loc="${loc || '-'}"`);
    const isHtml = /\btext\/html\b/i.test(ct);
    if (isHtml) sawHtmlHint = true;
    const isAttachment = /attachment/i.test(cd);
    if (status === 403) {
      return { skip: true, reason: 'forbidden', tryBrowser: true };
    }
    if (status >= 300 && status < 400 && loc) {
      const next = new URL(loc, url).toString();
      if (looksLikeFilePath(next) || /download|file|export/i.test(next)) {
        return { skip: true, reason: `redirect-to-file(${next})`, tryBrowser: false, finalUrl: next };
      }
      try {
        const probe = await fetch(next, { method: 'GET', redirect: 'manual' });
        const pct = probe.headers.get('content-type') || '';
        const isHtmlTarget = /\btext\/html\b/i.test(pct);
        if (isHtmlTarget) {
          return { skip: true, reason: `marketing-redirect(${next})`, tryBrowser: false, finalUrl: next };
        }
      } catch {}
      url = next;
      continue;
    }
    if (isAttachment) return { skip: true, reason: 'attachment', tryBrowser: false, finalUrl: url };
    if (!isHtml && ct) return { skip: true, reason: `non-HTML (${ct})`, tryBrowser: false, finalUrl: url };
    return { skip: false, reason: null, tryBrowser: false, finalUrl: url };
  }
  log.debug(`[PRECHECK] Too many redirects >= ${PRECHECK_MAX_REDIRECTS}`);
  return { skip: true, reason: `redirect-loop(${PRECHECK_MAX_REDIRECTS})`, tryBrowser: sawHtmlHint, finalUrl: null };
} // [Navigations & heuristics / handling redirects] [4]

// ---------- Browser lifecycle ----------
let browser;
async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browser) { try { await browser.close(); } catch {} }
  log.info(`[BROWSER] Launch headless Chromium`);
  browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: CHROMIUM_ARGS });
  return browser;
} // [Playwright best practices] [13]

// ---------- Redirect chain builder (document-only) ----------
function buildRedirectChainForResponse(resp, maxLen = 50) {
  const chain = [];
  // Учитываем цепочку только для документной навигации
  const req = resp.request();
  if (req.resourceType() !== 'document') return chain;
  let prev = req.redirectedFrom();
  let toUrl = req.url();
  const status = resp.status();
  while (prev) {
    chain.push({ from: prev.url(), to: toUrl, status });
    toUrl = prev.url();
    prev = prev.redirectedFrom();
    if (chain.length >= maxLen) break;
  }
  return chain.reverse();
} // [Playwright Request.redirectedFrom usage] [12]

// ---------- Quiet network window ----------
async function quietWindowWait({ inflightRef, lastChangeRef, timeoutMs, quietMs }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const quietFor = Date.now() - lastChangeRef.value;
    if (inflightRef.value === 0 && quietFor >= quietMs) return;
    await new Promise(r => setTimeout(r, 100));
  }
} // [Wait strategy guidance] [14]

// ---------- Core scan with Playwright ----------
async function scanWithBrowser(originDomain, startUrl, contextOpts = {}) {
  const b = await ensureBrowser();
  const context = await b.newContext({ acceptDownloads: true, ...contextOpts });

  // Глобальный лимитер редиректов для документных навигаций:
  // - для isNavigationRequest() с resourceType 'document' используем route.fetch({ maxRedirects })
  // - ассеты пропускаем без ограничения, чтобы не ломать рендер
  await context.route('**', async route => {
    const request = route.request();
    const isDoc = request.resourceType() === 'document';
    const isNav = request.isNavigationRequest();
    if (isDoc && isNav) {
      try {
        const response = await route.fetch({ maxRedirects: MAX_REDIRECT_STEPS });
        return route.fulfill({ response });
      } catch (e) {
        // Если maxRedirects сработал, прерываем навигацию «аккуратно»
        return route.fulfill({
          status: 508,
          body: 'Loop Detected: too many redirects'
        });
      }
    }
    return route.continue();
  }); // [Limit redirects for page.goto via routing] [4][5]

  const page = await context.newPage();

  const seenDomains = new Set();
  const redirectLog = [];
  const visitedUrls = new Set();
  const inflightRef = { value: 0 };
  const lastChangeRef = { value: Date.now() };

  if (DEBUG_ENABLED) {
    page.on('console', msg => log.debug(`[PAGE.CONSOLE] ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', err => log.debug(`[PAGE.ERROR] ${err?.message}`));
    page.on('requestfailed', req => log.debug(`[REQ.FAIL] ${req.url()} reason=${req.failure()?.errorText}`));
  } // [Console/request monitoring] [13]

  page.on('download', async dl => {
    try { await dl.failure().catch(() => {}); } catch {}
    log.debug(`[SCAN] Download ignored: ${dl.url()}`);
  }); // [Downloads handling] [13]

  const onReq = req => {
    inflightRef.value++;
    lastChangeRef.value = Date.now();
    const d = extractDomain(req.url());
    if (d) seenDomains.add(d);
    log.debug(`[REQ] ${req.method()} ${req.url()}`);
  };
  const onResp = resp => {
    inflightRef.value = Math.max(0, inflightRef.value - 1);
    lastChangeRef.value = Date.now();
    const d = extractDomain(resp.url());
    if (d) seenDomains.add(d);
    const status = resp.status();
    log.debug(`[RESP] ${status} ${resp.url()}`);
    // только документные редиректы считаем в цепочку
    if (status >= 300 && status < 400 && resp.request().resourceType() === 'document') {
      const piece = buildRedirectChainForResponse(resp, MAX_REDIRECT_STEPS + 5);
      redirectLog.push(...piece);
    }
  };
  page.on('request', onReq);
  page.on('response', onResp);

  try {
    log.info(`[SCAN] goto(${startUrl}) domcontentloaded timeout=${NAV_TIMEOUT_MS}`);
    let response;
    try {
      response = await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (e) {
      const msg = String(e?.message || '');
      if (/Download is starting/i.test(msg)) {
        log.info(`[SCAN] goto triggered download; continue as non-HTML`);
      } else {
        throw e;
      }
    }

    // Если наш «ограничитель» вернул 508 — считаем как превышение редиректов
    if (response && response.status() === 508) {
      throw new Error(`Too many redirects (${MAX_REDIRECT_STEPS})`);
    }

    await quietWindowWait({ inflightRef, lastChangeRef, timeoutMs: NAV_TIMEOUT_MS, quietMs: QUIET_WINDOW_MS });
    const finalUrl = page.url();

    if (visitedUrls.has(finalUrl)) throw new Error('Redirect loop detected');
    visitedUrls.add(finalUrl);

    // Проверка цепочки только по документам
    const steps = redirectLog.length;
    if (steps > MAX_REDIRECT_STEPS) throw new Error(`Too many redirects (${steps})`);

    await context.close();

    const relatedDomains = Array.from(seenDomains)
      .filter(d => !d.includes('doubleclick') && !d.includes('google'))
      .sort();

    log.info(`[SCAN] Done finalUrl=${finalUrl} domains=${relatedDomains.length} redirects=${steps}`);
    return { finalUrl, relatedDomains, redirectChain: redirectLog };
  } catch (e) {
    try { await context.close(); } catch {}
    try {
      if (browser && typeof browser.isConnected === 'function' && !browser.isConnected()) {
        await browser.close(); browser = null;
      }
    } catch {}
    log.error(`[SCAN] Error: ${e?.message}`);
    throw e;
  } finally {
    page.off('request', onReq);
    page.off('response', onResp);
  }
}

// ---------- High-level scan with precheck and escalation ----------
async function scanDomainOnce(originDomain) {
  const startUrl = `https://${originDomain}`;
  log.info(`[SCAN] Start domain="${originDomain}" url=${startUrl}`);
  const pre = await precheckFollowManually(startUrl);

  if (pre.skip && (pre.reason === 'attachment' || (pre.reason || '').startsWith('non-HTML'))) {
    log.info(`[SCAN] Skip non-HTML/attachment: ${pre.reason}`);
    return { finalUrl: pre.finalUrl || startUrl, relatedDomains: [originDomain], redirectChain: [], precheck: pre.reason };
  }

  let targetUrl = startUrl;

  if (pre.skip && /^marketing-redirect/.test(pre.reason || '') && pre.finalUrl) {
    log.info(`[SCAN] Marketing redirect -> follow target in browser: ${pre.finalUrl}`);
    targetUrl = pre.finalUrl;
  } else if (pre.skip && pre.tryBrowser) {
    log.info(`[SCAN] Escalation to browser due to ${pre.reason}`);
  }

  const contextOpts = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'UTC',
  };

  try {
    const result = await scanWithBrowser(originDomain, targetUrl, contextOpts);
    if (!result.relatedDomains.includes(originDomain)) {
      result.relatedDomains.unshift(originDomain);
    }
    return result;
  } catch (e) {
    log.warn(`[SCAN] Browser escalation failed: ${e?.message}`);
    return { finalUrl: targetUrl, relatedDomains: [originDomain], redirectChain: [], precheck: pre.reason || 'blocked' };
  }
}

// ---------- Cache helpers ----------
function getFromCache(domain) {
  const row = stmtSelect.get(domain);
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.ttl_at > now) {
    try {
      const out = {
        relatedDomains: JSON.parse(row.result_json),
        finalUrl: row.final_url || null,
        redirectChain: row.redirect_chain_json ? JSON.parse(row.redirect_chain_json) : [],
        cached: true,
        cachedAt: row.updated_at,
        ttlAt: row.ttl_at,
      };
      return out;
    } catch (e) {
      log.warn(`[CACHE] Parse error: ${e?.message}`);
      return null;
    }
  }
  return null;
}
function putToCache(domain, result) {
  const now = Math.floor(Date.now() / 1000);
  const ttlAt = now + CACHE_TTL_SECONDS;
  try {
    stmtUpsert.run({
      domain,
      result_json: JSON.stringify(result.relatedDomains || []),
      final_url: result.finalUrl || null,
      redirect_chain_json: JSON.stringify(result.redirectChain || []),
      updated_at: now,
      ttl_at: ttlAt,
    });
    log.info(`[CACHE] Upsert ${domain} ttlAt=${ttlAt}`);
  } catch (e) {
    log.warn(`[CACHE] Upsert error: ${e?.message}`);
  }
}

// ---------- Routes ----------
app.get('/domains', async (req, res) => {
  res.type('application/json');
  const raw = req.query.domain;
  log.info(`[HTTP] /domains?domain=${raw}`);
  const domain = normalizeDomain(raw);
  if (!domain) {
    res.status(400).json({ error: '"domain" must be a valid hostname', code: 'BAD_DOMAIN' });
    return;
  }

  const HARD_TIMEOUT = parseInt(process.env.HARD_TIMEOUT_MS || '70000', 10);
  const hardTimer = setTimeout(() => {
    try { if (!res.headersSent) res.status(504).json({ error: 'Gateway Timeout', code: 'TIMEOUT' }); } catch {}
  }, HARD_TIMEOUT);

  try {
    const cached = getFromCache(domain);
    if (cached) {
      log.info(`[HTTP] Cache HIT ${domain}`);
      res.status(200).json({
        domain,
        finalUrl: cached.finalUrl,
        relatedDomains: cached.relatedDomains,
        redirectChain: cached.redirectChain,
        cached: true,
        cachedAt: cached.cachedAt,
        ttlAt: cached.ttlAt,
        status: 'ok'
      });
      return;
    }

    const result = await scanDomainOnce(domain);

    if (result.precheck) {
      if ((result.precheck || '').startsWith('marketing-redirect')) {
        res.status(200).json({
          domain,
          finalUrl: result.finalUrl || `https://${domain}`,
          relatedDomains: [domain],
          redirectChain: [],
          cached: false,
          status: 'ok',
          note: result.precheck
        });
        return;
      }
      res.status(200).json({
        domain,
        finalUrl: result.finalUrl || `https://${domain}`,
        relatedDomains: [domain],
        redirectChain: [],
        cached: false,
        status: (result.precheck === 'forbidden' || result.precheck === 'blocked') ? 'blocked' : 'skipped',
        reason: result.precheck
      });
      return;
    }

    putToCache(domain, result);
    res.status(200).json({
      domain,
      finalUrl: result.finalUrl,
      relatedDomains: result.relatedDomains,
      redirectChain: result.redirectChain,
      cached: false,
      status: 'ok'
    });
  } catch (e) {
    const msg = String(e?.message || 'Internal error');
    log.error(`[HTTP] Error for ${domain}: ${msg}`);
    const forbidden = /403|forbidden|blocked/i.test(msg);
    res.status(forbidden ? 403 : 500).json({
      error: forbidden ? 'Forbidden' : 'Internal server error',
      code: forbidden ? 'FORBIDDEN' : 'INTERNAL',
      details: msg
    });
  } finally {
    clearTimeout(hardTimer);
  }
});

app.get('/health', (_req, res) => {
  res.type('application/json');
  res.json({ ok: true });
});

// ---------- Signals ----------
process.on('SIGTERM', async () => {
  log.info('[SIGNAL] SIGTERM');
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});
process.on('SIGINT', async () => {
  log.info('[SIGNAL] SIGINT');
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});

// ---------- Start ----------
app.listen(PORT, () => {
  log.info(`Domain scanner service listening on port ${PORT}`);
});

