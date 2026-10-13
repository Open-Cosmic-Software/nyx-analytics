#!/usr/bin/env node
/* Nyx Analytics — privacy-first, cookieless web analytics 🦞🌌
   Express + better-sqlite3. No cookies, no cross-site tracking, IPs never stored
   (only a daily, salted, one-way visitor hash). Region is inferred from the
   browser timezone, never from IP geolocation. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

// ── tiny .env loader (no dep) ───────────────────────────────────────────────
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = parseInt(process.env.PORT) || 3920;
const WEB_PASSWORD = process.env.WEB_PASSWORD || 'nyx';
const API_KEY = process.env.API_KEY || ''; // for agents / CLI (Bearer token)
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const INGEST_SALT = process.env.INGEST_SALT || 'nyx-analytics-salt';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'analytics.db');
const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS, 10) || 0; // 0 = keep forever; >0 purges older raw events (data minimisation)

// ── DB ──────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    name TEXT,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    day TEXT NOT NULL,
    path TEXT NOT NULL,
    source TEXT,
    referrer TEXT,
    country TEXT,
    tz TEXT,
    browser TEXT,
    os TEXT,
    device TEXT,
    lang TEXT,
    name TEXT,
    vh TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site_id, ts);
  CREATE INDEX IF NOT EXISTS idx_events_site_day ON events(site_id, day);
  CREATE INDEX IF NOT EXISTS idx_events_vh ON events(site_id, vh, day);
`);
// additive migrations: each column is added once for installs created before it existed.
function ensureColumn(name, decl) {
  if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${decl}`);
}
ensureColumn('name', 'TEXT'); // custom-event / goal name
ensureColumn('utm_medium', 'TEXT'); // campaign medium (utm_medium)
ensureColumn('utm_campaign', 'TEXT'); // campaign name (utm_campaign)
ensureColumn('dur', 'INTEGER'); // engagement seconds (set by a follow-up beacon on page leave)
ensureColumn('props', 'TEXT'); // custom event properties, JSON object as text
ensureColumn('scroll', 'INTEGER'); // max scroll depth in % (set by the engagement beacon)

// share links + funnels live in their own small tables (additive, safe on old installs)
db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    token TEXT PRIMARY KEY,
    site_id INTEGER NOT NULL,
    created INTEGER NOT NULL
  );
  -- visitors that touched an internal path (CMS preview etc.) are skipped for the rest of that day
  CREATE TABLE IF NOT EXISTS internal_vh (
    site_id INTEGER NOT NULL,
    vh TEXT NOT NULL,
    day TEXT NOT NULL,
    PRIMARY KEY (site_id, vh, day)
  );
  CREATE TABLE IF NOT EXISTS funnels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    steps TEXT NOT NULL, -- JSON array of {type:'page'|'goal', value}
    created INTEGER NOT NULL
  );
`);

const norm = (d) => String(d || '').toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '').trim();
const getSiteByDomain = db.prepare('SELECT * FROM sites WHERE domain = ?');
const insSite = db.prepare('INSERT OR IGNORE INTO sites (domain, name, created) VALUES (?, ?, ?)');
const allSites = db.prepare('SELECT * FROM sites ORDER BY domain');
const insEvent = db.prepare(`INSERT INTO events (site_id, ts, day, path, source, referrer, country, tz, browser, os, device, lang, name, utm_medium, utm_campaign, dur, props, vh)
  VALUES (@site_id, @ts, @day, @path, @source, @referrer, @country, @tz, @browser, @os, @device, @lang, @name, @utm_medium, @utm_campaign, @dur, @props, @vh)`);
// engagement: attach a visit duration (seconds) to the visitor's most recent pageview for that path.
const updDur = db.prepare(`UPDATE events SET dur = MAX(COALESCE(dur, 0), @dur), scroll = CASE WHEN @scroll IS NULL THEN scroll ELSE MAX(COALESCE(scroll, 0), @scroll) END WHERE id = (
  SELECT id FROM events WHERE site_id = @site_id AND vh = @vh AND name IS NULL AND path = @path AND ts >= @since
  ORDER BY id DESC LIMIT 1)`);

// ── internal traffic (13.10.2026) ────────────────────────────────────────────
// Paths that only the shop team opens (CMS preview, admin). A visitor who hits one is
// treated as internal for the rest of that day and no longer counted. Per-domain list,
// extend via INTERNAL_PATHS="domain:/prefix,domain:/prefix2".
const INTERNAL_PATHS = { 'pastaclean.tv': ['/rhweb/', '/admin', '/widgets/'] };
for (const part of String(process.env.INTERNAL_PATHS || '').split(',')) {
  const [d, pre] = part.split(':');
  if (d && pre) (INTERNAL_PATHS[d.trim()] || (INTERNAL_PATHS[d.trim()] = [])).push(pre.trim());
}
function backfillInternal() {
  for (const [d, prefixes] of Object.entries(INTERNAL_PATHS)) {
    const site = db.prepare('SELECT id FROM sites WHERE domain = ?').get(d);
    if (!site) continue;
    for (const pre of prefixes) {
      db.prepare(`INSERT OR IGNORE INTO internal_vh (site_id, vh, day) SELECT DISTINCT site_id, vh, day FROM events WHERE site_id = ? AND path >= ? AND path < ?`).run(site.id, pre, pre + '\uffff');
    }
  }
}
const insInternal = db.prepare('INSERT OR IGNORE INTO internal_vh (site_id, vh, day) VALUES (?, ?, ?)');
const isInternal = db.prepare('SELECT 1 FROM internal_vh WHERE site_id = ? AND vh = ? AND day = ?');

// ── payment providers (13.10.2026) ───────────────────────────────────────────
// Customers coming back from PayPal/Klarna are not a traffic source. Raw rows keep the
// host (no data loss); the sources panel hides them and shows them as a separate note.
const PAYMENT_HOSTS = ['paypal.com', 'klarna.com', 'js.klarna.com', 'x.klarnacdn.net', 'mollie.com', 'pay.amazon.com', 'payments.amazon.de', 'payments.amazon.com', 'stripe.com', 'checkout.stripe.com', 'sofort.com', 'giropay.de', 'paydirekt.de', 'ideal.nl', 'pay.google.com', 'unzer.com', 'computop-paygate.com', 'secure.ogone.com', 'ratepay.com', 'pay.payone.com', 'mollie.ideal.nl'];
backfillInternal();
const PAYMENT_SQL = PAYMENT_HOSTS.map(() => '?').join(',');
function isPaymentHost(h) { return PAYMENT_HOSTS.includes(h) || /(^|\.)(paypal|klarna|mollie|stripe|sofort|giropay|unzer|ratepay|payone)\./.test(h); }

// Custom event properties stay developer-defined and small — never a place for PII to pile up.
function sanitizeProps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(raw)) {
    if (n++ >= 12) break; // cap key count
    const key = String(k).slice(0, 40).trim();
    if (!key) continue;
    const v = raw[k];
    if (v == null || typeof v === 'object') continue; // scalars only
    out[key] = String(v).slice(0, 80);
  }
  const keys = Object.keys(out);
  if (!keys.length) return null;
  const json = JSON.stringify(out);
  return json.length > 800 ? null : json; // hard cap on total size
}

// ── UA parsing + bot filter ─────────────────────────────────────────────────
const BOT_RE = /bot|crawl|spider|slurp|bing|google|yandex|baidu|duckduck|facebookexternal|embedly|quora|pinterest|slackbot|telegrambot|whatsapp|twitter|discordbot|preview|monitor|uptime|pingdom|lighthouse|headless|phantom|curl|wget|python-requests|axios|node-fetch|go-http/i;
function parseUA(ua) {
  ua = ua || '';
  if (!ua || BOT_RE.test(ua)) return null; // drop bots/crawlers entirely
  let browser = 'Other', os = 'Other', device = 'Desktop';
  if (/iPad/i.test(ua) || (/Tablet/i.test(ua) && !/Mobile/i.test(ua))) device = 'Tablet';
  else if (/Mobi|Android|iPhone|iPod/i.test(ua)) device = 'Mobile';
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = 'Safari';
  return { browser, os, device };
}

// Rough timezone → ISO country (privacy-preserving alternative to IP geo).
const TZ_COUNTRY = require('./tz-country.js');
function countryFromTz(tz) { return (tz && TZ_COUNTRY[tz]) || null; }

function dayStr(ts) { return new Date(ts).toISOString().slice(0, 10); }
function visitorHash(siteId, ip, ua, day) {
  return crypto.createHash('sha256').update(`${INGEST_SALT}|${day}|${siteId}|${ip}|${ua}`).digest('hex').slice(0, 24);
}
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || '0.0.0.0';
}

// ── app ─────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
// Accept both application/json (dashboard) and text/plain (cross-origin beacons).
app.use(express.json({ limit: '32kb', type: ['application/json', 'text/plain'] }));
app.disable('x-powered-by');

// Lightweight in-memory rate limiter (fixed window per key). No external dep.
const rl = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let e = rl.get(key);
  if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; rl.set(key, e); }
  e.n++;
  return e.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rl) if (v.reset < now) rl.delete(k); }, 60000).unref();

// ── tracking script (served with permissive CORS so any site can embed) ──────
const TRACKER = fs.readFileSync(path.join(__dirname, 'public', 'nyx.js'), 'utf8');
app.get('/nyx.js', (_req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(TRACKER);
});

// ── collection endpoint ─────────────────────────────────────────────────────
function collect(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  // flood / stat-poisoning guard: cap events per IP per minute (legit SPA bursts fit easily)
  if (rateLimited('c:' + clientIp(req), 600, 60000)) return res.status(204).end();
  const b = req.method === 'GET' ? req.query : (req.body || {});
  const domain = norm(b.d || b.domain);
  if (!domain) return res.status(204).end();
  const site = getSiteByDomain.get(domain);
  if (!site) return res.status(202).end(); // unknown site → silently ignore
  const ua = parseUA(req.headers['user-agent']);
  if (!ua) return res.status(204).end(); // bot

  const ts = Date.now();
  const day = dayStr(ts);
  let pth = String(b.p || b.path || '/').slice(0, 512);
  try { pth = decodeURI(pth); } catch {}
  if (pth.length > 1) pth = pth.replace(/\/+$/, '') || '/';
  const ip = clientIp(req);
  const vh = visitorHash(site.id, ip, req.headers['user-agent'] || '', day);

  // internal visitor (CMS preview etc.): mark for the day and drop everything from them.
  const intern = INTERNAL_PATHS[domain] || [];
  if (intern.some((pre) => pth.startsWith(pre))) { insInternal.run(site.id, vh, day); return res.status(204).end(); }
  if (isInternal.get(site.id, vh, day)) return res.status(204).end();

  // engagement beacon: attach a visit duration (+ max scroll depth) to the visitor's latest pageview (no new row).
  if (b.e === 'engagement') {
    const dur = Math.max(0, Math.min(7200, parseInt(b.dur, 10) || 0)); // cap at 2h
    const sc = b.sc == null || b.sc === '' ? null : Math.max(0, Math.min(100, parseInt(b.sc, 10) || 0));
    if (dur > 0 || sc != null) updDur.run({ site_id: site.id, vh, path: pth, dur, scroll: sc, since: ts - 6 * 3600000 });
    return res.status(204).end();
  }

  // referrer → source host
  let referrer = String(b.r || b.referrer || '').slice(0, 512);
  let source = 'Direct';
  const utm = String(b.s || b.utm || '').slice(0, 60);
  if (utm) source = utm;
  else if (referrer) {
    try { const h = norm(new URL(referrer).hostname); if (h && h !== domain) source = h; } catch {}
  }
  const utmMedium = String(b.um || b.utm_medium || '').slice(0, 60).trim() || null;
  const utmCampaign = String(b.uc || b.utm_campaign || '').slice(0, 80).trim() || null;
  const tz = String(b.tz || '').slice(0, 60) || null;
  const lang = String(b.l || b.lang || '').slice(0, 12).split(',')[0] || null;
  const name = String(b.n || b.name || '').slice(0, 80).trim() || null; // custom event / goal
  const props = name ? sanitizeProps(b.pr) : null; // properties only attach to named events
  insEvent.run({
    site_id: site.id, ts, day, path: pth, source, referrer: referrer || null,
    country: countryFromTz(tz), tz, browser: ua.browser, os: ua.os, device: ua.device,
    lang, name, utm_medium: utmMedium, utm_campaign: utmCampaign, dur: null, props, vh,
  });
  res.status(204).end();
}
app.options('/api/collect', (_req, res) => { res.set('Access-Control-Allow-Origin', '*').set('Access-Control-Allow-Headers', 'Content-Type').status(204).end(); });
app.post('/api/collect', collect);
app.get('/api/collect', collect);

// ── auth (password → in-memory session token, mirrors NyxVault) ──────────────
const sessions = new Map();
function newToken() { return crypto.randomBytes(24).toString('hex'); }
app.post('/auth/login', (req, res) => {
  if (rateLimited('login:' + clientIp(req), 10, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
  const pw = String((req.body && req.body.password) || '');
  const ok = pw.length === WEB_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(WEB_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  const token = newToken();
  sessions.set(token, { expires: Date.now() + 7 * 864e5 });
  res.json({ token });
});
function checkApiKey(req) {
  if (!API_KEY) return false;
  const hdr = String(req.headers['authorization'] || '');
  const key = hdr.startsWith('Bearer ') ? hdr.slice(7) : String(req.headers['x-api-key'] || '');
  return key.length === API_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(API_KEY));
}
function auth(req, res, next) {
  if (checkApiKey(req)) return next(); // agents / CLI
  const t = req.headers['x-session-token'];
  const s = t && sessions.get(t);
  if (s && s.expires > Date.now()) return next();
  if (s) sessions.delete(t);
  res.status(401).json({ error: 'Not authenticated' });
}

// share-token auth: read-only stats access scoped to exactly one site.
// Accepted as ?share=<token>; the handler must verify req.shareSite matches the queried site.
const getShare = db.prepare('SELECT * FROM shares WHERE token = ?');
function authOrShare(req, res, next) {
  const tok = String(req.query.share || '');
  if (/^[a-f0-9]{32,64}$/.test(tok)) {
    const sh = getShare.get(tok);
    if (sh) { req.shareSiteId = sh.site_id; return next(); }
  }
  return auth(req, res, next);
}
function shareScopeOk(req, site) { return req.shareSiteId == null || req.shareSiteId === site.id; }

// ── sites management ─────────────────────────────────────────────────────────
const sitesListHandler = (_req, res) => res.json(allSites.all());
const sitesCreateHandler = (req, res) => {
  const rawDomain = norm(req.body && req.body.domain);
  let domain = rawDomain;
  let displayName = rawDomain; // keep Unicode original for a readable display name (e.g. ernährungs-plan.de)
  // IDN support: convert Unicode/umlaut domains to Punycode (stored), keep Unicode as display name
  if (domain && /[^\x00-\x7F]/.test(domain)) {
    try { domain = new URL('http://' + domain).hostname; } catch (_) { /* fall through to validation */ }
  }
  // Allow ASCII domains AND Punycode (xn--...). Unicode input was converted above.
  if (!domain || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain)) return res.status(400).json({ error: 'Enter a valid domain, e.g. example.com' });
  insSite.run(domain, (req.body && req.body.name) || displayName, Date.now());
  res.json(getSiteByDomain.get(domain));
};
app.get('/api/sites', auth, sitesListHandler);
app.post('/api/sites', auth, sitesCreateHandler);
app.delete('/api/sites/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM events WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── /api/v1 — stable agent/CLI surface (Authorization: Bearer <API_KEY>) ──────
app.get('/api/v1', (_req, res) => res.json({
  name: 'Nyx Analytics API', version: '1',
  auth: 'Authorization: Bearer <API_KEY>',
  endpoints: {
    'GET /api/v1/sites': 'list tracked sites',
    'POST /api/v1/sites': 'add a site { domain }',
    'GET /api/v1/stats?site=&period=': 'aggregated stats (period: today|7d|30d|90d|12mo, or from=YYYY-MM-DD&to=YYYY-MM-DD)',
    'GET /api/v1/realtime?site=': 'online count, last-30-min pulse + recent events',
  },
  filters: 'add any of country,source,page,browser,os,device,lang,medium,campaign,goal to /stats to segment',
}));
app.get('/api/v1/sites', auth, sitesListHandler);
app.post('/api/v1/sites', auth, sitesCreateHandler);

// ── stats ────────────────────────────────────────────────────────────────────
const PERIODS = { today: 1, '7d': 7, '30d': 30, '90d': 90, '12mo': 365 };
function rangeFor(query) {
  const now = Date.now();
  // custom range: from/to are YYYY-MM-DD (inclusive)
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? Date.parse(query.from + 'T00:00:00Z') : null;
  if (from != null && !Number.isNaN(from)) {
    const toRaw = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? Date.parse(query.to + 'T00:00:00Z') : from;
    const end = Math.min(now, (Number.isNaN(toRaw) ? from : toRaw) + 864e5); // inclusive end day
    const days = Math.max(1, Math.round((end - from) / 864e5));
    return { start: from, end, days, period: 'custom', hourly: days <= 1 };
  }
  const period = PERIODS[query.period] ? query.period : '7d';
  const days = PERIODS[period];
  const start = period === 'today' ? new Date(new Date(now).toISOString().slice(0, 10)).getTime() : now - days * 864e5;
  return { start, end: now, days, period, hourly: period === 'today' };
}

// Whitelisted segmentation filters — click any breakdown row in the dashboard to drill in.
// Every value is bound as a parameter; only these exact column names are ever interpolated.
const FILTER_COLS = { country: 'country', source: 'source', page: 'path', browser: 'browser', os: 'os', device: 'device', lang: 'lang', medium: 'utm_medium', campaign: 'utm_campaign' };
function buildFilters(query) {
  const clauses = [], params = [];
  for (const key of Object.keys(FILTER_COLS)) {
    const v = query[key];
    if (v != null && v !== '') { clauses.push(`${FILTER_COLS[key]} = ?`); params.push(String(v).slice(0, 200)); }
  }
  const goal = query.goal != null && query.goal !== '' ? String(query.goal).slice(0, 80) : null;
  return { clauses, params, goal };
}

function statsHandler(req, res) {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!shareScopeOk(req, site)) return res.status(403).json({ error: 'Share link is limited to another site' });
  const sid = site.id;
  const { start, end, days, period, hourly } = rangeFor(req.query);
  const { clauses, params, goal } = buildFilters(req.query);

  // pageview WHERE = time window + segmentation filters. A goal filter narrows the visitor
  // set to those who fired that event in-range (so every breakdown reflects converters only).
  let where = 'site_id = ? AND ts >= ? AND ts < ? AND name IS NULL AND NOT EXISTS (SELECT 1 FROM internal_vh i WHERE i.site_id = events.site_id AND i.vh = events.vh AND i.day = events.day)';
  const args = [sid, start, end, ...params];
  if (clauses.length) where += ' AND ' + clauses.join(' AND ');
  if (goal) { where += ' AND vh IN (SELECT vh FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = ?)'; args.push(sid, start, end, goal); }

  const totals = db.prepare(`SELECT COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE ${where}`).get(...args);
  const bounceRow = db.prepare(`SELECT COUNT(*) AS bounced FROM (SELECT vh, COUNT(*) c FROM events WHERE ${where} GROUP BY vh HAVING c = 1)`).get(...args);
  const bounce = totals.visitors ? Math.round((bounceRow.bounced / totals.visitors) * 100) : 0;
  const viewsPerVisitor = totals.visitors ? +(totals.pageviews / totals.visitors).toFixed(1) : 0;
  const durRow = db.prepare(`SELECT AVG(dur) d FROM events WHERE ${where} AND dur IS NOT NULL`).get(...args);
  const duration = durRow && durRow.d != null ? Math.round(durRow.d) : null; // avg engaged seconds

  // trend vs the previous equal-length window (same filters)
  const len = end - start;
  const prevArgs = args.slice(); prevArgs[1] = start - len; prevArgs[2] = start;
  if (goal) { prevArgs[prevArgs.length - 3] = start - len; prevArgs[prevArgs.length - 2] = start; }
  const prev = db.prepare(`SELECT COUNT(*) pageviews, COUNT(DISTINCT vh) visitors FROM events WHERE ${where}`).get(...prevArgs);
  const pct = (cur, was) => (was ? Math.round(((cur - was) / was) * 100) : null);

  // time series (per hour for a single day, else per day)
  let series;
  if (hourly) {
    const rows = db.prepare(`SELECT CAST((ts/3600000) AS INT) AS bucket, COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE ${where} GROUP BY bucket`).all(...args);
    const map = new Map(rows.map((r) => [r.bucket, r]));
    const startH = Math.floor(start / 3600000);
    series = Array.from({ length: 24 }, (_, i) => {
      const r = map.get(startH + i);
      return { label: String(i).padStart(2, '0'), visitors: r ? r.v : 0, pageviews: r ? r.pv : 0 };
    });
  } else {
    const rows = db.prepare(`SELECT day, COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE ${where} GROUP BY day`).all(...args);
    const map = new Map(rows.map((r) => [r.day, r]));
    series = Array.from({ length: days }, (_, i) => {
      const d = new Date(start + i * 864e5).toISOString().slice(0, 10);
      const r = map.get(d);
      return { label: d.slice(5), day: d, visitors: r ? r.v : 0, pageviews: r ? r.pv : 0 };
    });
  }

  // previous year: same window shifted by 364 days (same weekdays). Null until data reaches back that far.
  const yoyStart = start - 364 * 864e5, yoyEnd = end - 364 * 864e5;
  const firstTs = db.prepare('SELECT MIN(ts) t FROM events WHERE site_id = ?').get(sid).t;
  let yoy = null;
  if (firstTs != null && firstTs <= yoyStart) {
    const ya = args.slice(); ya[1] = yoyStart; ya[2] = yoyEnd;
    if (goal) { ya[ya.length - 3] = yoyStart; ya[ya.length - 2] = yoyEnd; }
    const y = db.prepare(`SELECT COUNT(*) pageviews, COUNT(DISTINCT vh) visitors FROM events WHERE ${where}`).get(...ya);
    yoy = { visitors: pct(totals.visitors, y.visitors), pageviews: pct(totals.pageviews, y.pageviews), was: y };
  }

  const topBy = (col, limit = 8) => db.prepare(
    `SELECT ${col} AS name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE ${where} AND ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY visitors DESC, pageviews DESC LIMIT ${limit}`,
  ).all(...args);

  // entry / exit pages: first / last pageview of each visit (vh,day), counted as visits.
  const edge = (dir, limit = 8) => db.prepare(
    `SELECT path AS name, COUNT(*) AS visitors, COUNT(*) AS pageviews FROM (
       SELECT path, ROW_NUMBER() OVER (PARTITION BY vh, day ORDER BY ts ${dir}, id ${dir}) rn FROM events WHERE ${where}
     ) WHERE rn = 1 GROUP BY path ORDER BY visitors DESC LIMIT ${limit}`,
  ).all(...args);

  // goals: conversion = unique converters / unique visitors in the (filtered) range.
  const goalRows = db.prepare(
    `SELECT name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NOT NULL GROUP BY name ORDER BY visitors DESC, pageviews DESC LIMIT 12`,
  ).all(sid, start, end);
  const goals = goalRows.map((g) => ({ ...g, cr: totals.visitors ? +((g.visitors / totals.visitors) * 100).toFixed(1) : 0 }));

  // properties: only meaningful when drilled into a single goal — top values per property key.
  let properties = null;
  if (goal) {
    const rows = db.prepare(`SELECT props FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = ? AND props IS NOT NULL`).all(sid, start, end, goal);
    const byKey = {};
    for (const r of rows) {
      let obj; try { obj = JSON.parse(r.props); } catch { continue; }
      for (const k of Object.keys(obj || {})) {
        (byKey[k] || (byKey[k] = {}));
        const val = String(obj[k]);
        byKey[k][val] = (byKey[k][val] || 0) + 1;
      }
    }
    properties = Object.keys(byKey).map((k) => ({
      key: k,
      values: Object.entries(byKey[k]).map(([name, pageviews]) => ({ name, pageviews, visitors: pageviews })).sort((a, b) => b.pageviews - a.pageviews).slice(0, 8),
    }));
  }

  // sources without payment providers (returning customers, not traffic) — shown separately
  // one source query; payment providers (returning customers, not traffic) are split off
  const srcAll = db.prepare(
    `SELECT source AS name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE ${where} AND source IS NOT NULL AND source != '' GROUP BY source ORDER BY visitors DESC, pageviews DESC LIMIT 40`,
  ).all(...args);
  const sourcesClean = srcAll.filter((r) => !isPaymentHost(r.name)).slice(0, 8);
  const paymentReturns = srcAll.filter((r) => isPaymentHost(r.name));

  // ── commerce (event "Purchase" with props.value) ──
  const purchases = db.prepare(
    `SELECT vh, day, CAST(json_extract(props, '$.value') AS REAL) AS value FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'Purchase'`,
  ).all(sid, start, end);
  let commerce = null;
  if (purchases.length) {
    // first non-payment source per buying visit (vh, day) — one query instead of one per order
    const keys = [...new Set(purchases.map((x) => x.vh + '|' + x.day))];
    const days = [...new Set(purchases.map((x) => x.day))];
    const srcRows = db.prepare(
      `SELECT vh, day, source FROM (
         SELECT vh, day, source, ROW_NUMBER() OVER (PARTITION BY vh, day ORDER BY ts, id) rn
         FROM events WHERE site_id = ? AND day IN (${days.map(() => '?').join(',')}) AND name IS NULL AND source NOT IN (${PAYMENT_SQL})
           AND vh IN (SELECT vh FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'Purchase')
       ) WHERE rn = 1`,
    ).all(sid, ...days, ...PAYMENT_HOSTS, sid, start, end);
    const srcOf = new Map(srcRows.map((r) => [r.vh + '|' + r.day, r.source]));
    void keys;
    const bySrc = new Map();
    let revenue = 0;
    for (const pch of purchases) {
      const v = Number.isFinite(pch.value) ? pch.value : 0;
      revenue += v;
      const src = srcOf.get(pch.vh + '|' + pch.day) || 'Direct';
      const e = bySrc.get(src) || { name: src, orders: 0, revenue: 0 };
      e.orders++; e.revenue += v; bySrc.set(src, e);
    }
    const prevRev = db.prepare(
      `SELECT COUNT(*) n, SUM(CAST(json_extract(props, '$.value') AS REAL)) r FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'Purchase'`,
    ).get(sid, start - len, start);
    const orders = purchases.length;
    commerce = {
      orders, revenue: +revenue.toFixed(2), aov: +(revenue / orders).toFixed(2),
      cr: totals.visitors ? +((new Set(purchases.map((x) => x.vh + x.day)).size / totals.visitors) * 100).toFixed(2) : 0,
      // no trend against a near-empty baseline (e.g. the week tracking started) — a % of almost nothing is noise
      trend: prevRev.n >= 5 ? { orders: pct(orders, prevRev.n), revenue: pct(revenue, prevRev.r || 0) } : { orders: null, revenue: null },
      bySource: [...bySrc.values()].map((x) => ({ ...x, revenue: +x.revenue.toFixed(2), visitors: x.orders })).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    };
  }

  // ── site search (event "Search" with props.q + props.results) ──
  const searchRows = db.prepare(
    `SELECT LOWER(TRIM(json_extract(props, '$.q'))) q, CAST(json_extract(props, '$.results') AS INTEGER) n, vh FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'Search' AND props IS NOT NULL`,
  ).all(sid, start, end);
  let search = null;
  if (searchRows.length) {
    const agg = new Map();
    for (const r of searchRows) {
      if (!r.q) continue;
      const e = agg.get(r.q) || { name: r.q, searches: 0, zero: 0, vhs: new Set() };
      e.searches++; if (r.n === 0) e.zero++; e.vhs.add(r.vh); agg.set(r.q, e);
    }
    const all = [...agg.values()].map((e) => ({ name: e.name, pageviews: e.searches, visitors: e.vhs.size, zero: e.zero }));
    search = {
      total: searchRows.length,
      zeroShare: +((searchRows.filter((r) => r.n === 0).length / searchRows.length) * 100).toFixed(1),
      top: all.slice().sort((a, b) => b.pageviews - a.pageviews).slice(0, 10),
      zeroResults: all.filter((e) => e.zero > 0).sort((a, b) => b.zero - a.zero).slice(0, 10).map((e) => ({ ...e, pageviews: e.zero, visitors: e.zero })),
    };
  }

  // ── broken pages (event "404" with props.url / props.from) ──
  const notFound = db.prepare(
    `SELECT json_extract(props, '$.url') AS name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors, MAX(json_extract(props, '$.from')) AS fromPage FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = '404' GROUP BY name ORDER BY pageviews DESC LIMIT 10`,
  ).all(sid, start, end);

  // ── scroll depth per page (pages with enough measured views) ──
  const scrollPages = db.prepare(
    `SELECT path AS name, COUNT(*) AS pageviews, ROUND(AVG(scroll)) AS avg, ROUND(100.0 * SUM(scroll >= 75) / COUNT(*)) AS deep FROM events WHERE ${where} AND scroll IS NOT NULL GROUP BY path HAVING COUNT(*) >= 5 ORDER BY pageviews DESC LIMIT 10`,
  ).all(...args).map((r) => ({ ...r, visitors: r.pageviews }));

  res.json({
    site: { domain: site.domain, name: site.name },
    period, range: { from: new Date(start).toISOString().slice(0, 10), to: new Date(end - 1).toISOString().slice(0, 10) },
    filters: Object.assign({}, ...Object.keys(FILTER_COLS).filter((k) => req.query[k]).map((k) => ({ [k]: req.query[k] })), goal ? { goal } : {}),
    totals: { visitors: totals.visitors, pageviews: totals.pageviews, bounce, viewsPerVisitor, duration },
    trend: { visitors: pct(totals.visitors, prev.visitors), pageviews: pct(totals.pageviews, prev.pageviews) },
    previous: { visitors: prev.visitors, pageviews: prev.pageviews },
    yoy,
    dataSince: firstTs ? new Date(firstTs).toISOString().slice(0, 10) : null,
    series,
    pages: topBy('path', 10),
    entryPages: edge('ASC', 8),
    exitPages: edge('DESC', 8),
    sources: sourcesClean,
    sourcesAll: srcAll.slice(0, 8),
    paymentReturns,
    commerce,
    search,
    notFound,
    scrollPages,
    mediums: topBy('utm_medium', 8),
    campaigns: topBy('utm_campaign', 8),
    countries: topBy('country', 8),
    browsers: topBy('browser', 6),
    os: topBy('os', 6),
    devices: topBy('device', 4),
    languages: topBy('lang', 6),
    goals,
    properties,
    realtime: db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND name IS NULL AND ts >= ?').get(sid, Date.now() - 5 * 60000).v,
  });
}
app.get('/api/stats', authOrShare, statsHandler);
app.get('/api/v1/stats', authOrShare, statsHandler);

// ── realtime: live visitors + per-minute pulse + recent event feed (last 30 min) ──
function realtimeHandler(req, res) {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!shareScopeOk(req, site)) return res.status(403).json({ error: 'Share link is limited to another site' });
  const sid = site.id, now = Date.now(), since = now - 30 * 60000;
  const online = db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND name IS NULL AND ts >= ?').get(sid, now - 5 * 60000).v;
  const rows = db.prepare('SELECT CAST((ts/60000) AS INT) b, COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND name IS NULL AND ts >= ? GROUP BY b').all(sid, since);
  const map = new Map(rows.map((r) => [r.b, r]));
  const startB = Math.floor(since / 60000);
  const minutes = Array.from({ length: 30 }, (_, i) => { const r = map.get(startB + i + 1); return { visitors: r ? r.v : 0, pageviews: r ? r.pv : 0 }; });
  const recent = db.prepare('SELECT ts, path, country, tz, browser, os, device, source, lang, name FROM events WHERE site_id = ? AND ts >= ? ORDER BY id DESC LIMIT 60').all(sid, since);
  res.json({ online, minutes, recent, now });
}
app.get('/api/realtime', authOrShare, realtimeHandler);
app.get('/api/v1/realtime', authOrShare, realtimeHandler);

// ── share links: create / list / revoke (owner only) + resolve (public) ──────────
app.get('/api/shares', auth, (req, res) => {
  const rows = db.prepare('SELECT s.token, s.created, st.domain FROM shares s JOIN sites st ON st.id = s.site_id ORDER BY s.created DESC').all();
  res.json(rows);
});
app.post('/api/shares', auth, (req, res) => {
  const site = getSiteByDomain.get(norm(req.body && req.body.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  const token = newToken();
  db.prepare('INSERT INTO shares (token, site_id, created) VALUES (?, ?, ?)').run(token, site.id, Date.now());
  res.json({ token, domain: site.domain, url: '/share/' + token });
});
app.delete('/api/shares/:token', auth, (req, res) => {
  db.prepare('DELETE FROM shares WHERE token = ?').run(String(req.params.token));
  res.json({ ok: true });
});
// public: resolve a share token to its site (used by the read-only dashboard)
app.get('/api/share-info/:token', (req, res) => {
  const sh = getShare.get(String(req.params.token));
  if (!sh) return res.status(404).json({ error: 'Unknown or revoked share link' });
  const site = db.prepare('SELECT domain, name FROM sites WHERE id = ?').get(sh.site_id);
  res.json({ domain: site.domain, name: site.name });
});

// ── funnels: ordered steps (pages or goals), conversion measured per visitor in-range ──
app.get('/api/funnels', auth, (req, res) => {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  res.json(db.prepare('SELECT id, name, steps, created FROM funnels WHERE site_id = ? ORDER BY id').all(site.id).map((f) => ({ ...f, steps: JSON.parse(f.steps) })));
});
app.post('/api/funnels', auth, (req, res) => {
  const site = getSiteByDomain.get(norm(req.body && req.body.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  const name = String((req.body && req.body.name) || '').slice(0, 80).trim();
  const raw = (req.body && req.body.steps) || [];
  if (!name) return res.status(400).json({ error: 'Funnel needs a name' });
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) return res.status(400).json({ error: 'Funnel needs 2-8 steps' });
  const steps = raw.map((s) => ({
    type: s && s.type === 'goal' ? 'goal' : 'page',
    value: String((s && s.value) || '').slice(0, 200).trim(),
    label: String((s && (s.label || s.value)) || '').slice(0, 80).trim(),
  }));
  if (steps.some((s) => !s.value)) return res.status(400).json({ error: 'Every step needs a value' });
  const info = db.prepare('INSERT INTO funnels (site_id, name, steps, created) VALUES (?, ?, ?, ?)').run(site.id, name, JSON.stringify(steps), Date.now());
  res.json({ id: info.lastInsertRowid, name, steps });
});
app.delete('/api/funnels/:id', auth, (req, res) => {
  db.prepare('DELETE FROM funnels WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
// funnel evaluation: strictly ordered — a visitor counts for step N only after matching step N-1.
app.get('/api/funnels/:id/stats', authOrShare, (req, res) => {
  const f = db.prepare('SELECT * FROM funnels WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'Unknown funnel' });
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(f.site_id);
  if (!shareScopeOk(req, site)) return res.status(403).json({ error: 'Share link is limited to another site' });
  const { start, end } = rangeFor(req.query);
  const steps = JSON.parse(f.steps);
  // one pass per visitor: fetch matching events sorted by time, walk the step ladder.
  const conds = steps.map((s) => (s.type === 'goal' ? 'name = ?' : "(name IS NULL AND path = ?)"));
  const rows = db.prepare(
    `SELECT vh, ts, path, name FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND (${conds.join(' OR ')}) ORDER BY vh, ts, id`,
  ).all(f.site_id, start, end, ...steps.map((s) => s.value));
  const progress = new Map(); // vh → next step index the visitor still needs
  for (const r of rows) {
    const at = progress.get(r.vh) || 0;
    if (at >= steps.length) continue;
    const s = steps[at];
    const match = s.type === 'goal' ? r.name === s.value : r.name == null && r.path === s.value;
    if (match) progress.set(r.vh, at + 1);
  }
  const counts = steps.map(() => 0);
  for (const reached of progress.values()) for (let i = 0; i < reached; i++) counts[i]++;
  const out = steps.map((s, i) => ({
    label: s.label || s.value, type: s.type, value: s.value, visitors: counts[i],
    pctOfFirst: counts[0] ? +((counts[i] / counts[0]) * 100).toFixed(1) : 0,
    dropFromPrev: i > 0 && counts[i - 1] ? +((1 - counts[i] / counts[i - 1]) * 100).toFixed(1) : 0,
  }));
  res.json({ id: f.id, name: f.name, range: { from: new Date(start).toISOString().slice(0, 10), to: new Date(end - 1).toISOString().slice(0, 10) }, steps: out });
});

// ── static dashboard ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
// ── visitor journeys: session-based path transitions for a sankey flow ───────────
// A "session" = one visitor's pageviews with < 30 min between them.
// Returns the top N transitions per depth (entry → step 2 → step 3 …), plus exits.
app.get('/api/journeys', authOrShare, (req, res) => {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!shareScopeOk(req, site)) return res.status(403).json({ error: 'Share link is limited to another site' });
  const { start, end } = rangeFor(req.query);
  const maxDepth = Math.min(5, Math.max(2, parseInt(req.query.depth, 10) || 4));
  const GAP = 30 * 60000;
  const rows = db.prepare('SELECT vh, ts, path FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL ORDER BY vh, ts, id').all(site.id, start, end);
  const links = new Map(); // "depth|from|to" → count   (to = path or "✖ exit")
  let sessions = 0;
  let cur = null; // { vh, lastTs, steps: [paths] }
  const flush = (s) => {
    if (!s) return;
    sessions++;
    const steps = s.steps.slice(0, maxDepth);
    for (let i = 0; i < steps.length; i++) {
      const from = steps[i];
      const to = i + 1 < steps.length ? steps[i + 1] : (s.steps.length > maxDepth ? '…' : '✖ exit');
      const k = i + '|' + from + '|' + to;
      links.set(k, (links.get(k) || 0) + 1);
    }
  };
  for (const r of rows) {
    if (!cur || cur.vh !== r.vh || r.ts - cur.lastTs > GAP) { flush(cur); cur = { vh: r.vh, lastTs: r.ts, steps: [r.path] }; continue; }
    cur.lastTs = r.ts;
    // collapse immediate self-loops (reloads) — they add noise, not insight
    if (cur.steps[cur.steps.length - 1] !== r.path) cur.steps.push(r.path);
  }
  flush(cur);
  // keep the top 12 links per depth so the sankey stays readable
  const byDepth = new Map();
  for (const [k, count] of links) {
    const [d, from, to] = k.split('|');
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push({ depth: +d, from, to, count });
  }
  const out = [];
  for (const arr of byDepth.values()) {
    arr.sort((a, b) => b.count - a.count);
    out.push(...arr.slice(0, 12));
  }
  res.json({ sessions, maxDepth, links: out });
});


app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── data retention (privacy by design: minimise what we keep) ─────────────────
// When DATA_RETENTION_DAYS > 0, raw events older than the window are purged daily.
// Aggregates you've already exported stay yours; the raw rows simply don't linger.
const delOld = db.prepare('DELETE FROM events WHERE ts < ?');
function purgeOld() {
  if (RETENTION_DAYS <= 0) return;
  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  const info = delOld.run(cutoff);
  if (info.changes) console.log(`Nyx Analytics 🦞 retention: purged ${info.changes} events older than ${RETENTION_DAYS}d`);
}
if (RETENTION_DAYS > 0) { purgeOld(); setInterval(purgeOld, 24 * 3600 * 1000).unref(); }

// ── daily digest: one webhook message per day summarising every site (yesterday vs the day before).
// Configure DIGEST_WEBHOOK_URL (Discord-compatible) and optionally DIGEST_HOUR_UTC (default 7).
const DIGEST_WEBHOOK_URL = process.env.DIGEST_WEBHOOK_URL || '';
const DIGEST_HOUR_UTC = Math.min(23, Math.max(0, parseInt(process.env.DIGEST_HOUR_UTC, 10) || 7));
let lastDigestDay = null;
async function sendDigest() {
  const yStart = new Date(new Date(Date.now() - 864e5).toISOString().slice(0, 10)).getTime();
  const yEnd = yStart + 864e5, pStart = yStart - 864e5;
  const lines = [];
  for (const site of allSites.all()) {
    const cur = db.prepare('SELECT COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL').get(site.id, yStart, yEnd);
    if (!cur.pv) continue; // silent sites stay out of the report
    const was = db.prepare('SELECT COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL').get(site.id, pStart, yStart);
    const top = db.prepare("SELECT path, COUNT(*) c FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL GROUP BY path ORDER BY c DESC LIMIT 1").get(site.id, yStart, yEnd);
    const goals = db.prepare('SELECT COUNT(*) c FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NOT NULL').get(site.id, yStart, yEnd).c;
    const arrow = was.v ? (cur.v > was.v ? '⬆️' : cur.v < was.v ? '⬇️' : '➡️') : '✨';
    lines.push(`**${site.domain}** ${arrow} ${cur.v} visitors · ${cur.pv} views${goals ? ` · ${goals} events` : ''}${top ? ` · top \`${top.path}\`` : ''}`);
  }
  if (!lines.length) return;
  const body = { username: 'Nyx Analytics 🦞', content: `📊 **Daily digest — ${new Date(yStart).toISOString().slice(0, 10)}**\n` + lines.join('\n') };
  try {
    const r = await fetch(DIGEST_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error('digest webhook failed:', r.status);
  } catch (e) { console.error('digest webhook error:', e.message); }
}
if (DIGEST_WEBHOOK_URL) {
  setInterval(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === DIGEST_HOUR_UTC && lastDigestDay !== today) { lastDigestDay = today; sendDigest(); }
  }, 5 * 60000).unref();
}

// ── anomaly watchdog: hourly check of the last hour vs. the same hour on previous days.
// Baseline = median of the same UTC hour over the last 14 days — same-hour compare avoids
// the classic "every night is an incident" trap of naive averages. Cooldown 6h per site+kind.
const WATCH_MIN_VISITORS = Math.max(1, parseInt(process.env.WATCH_MIN_VISITORS, 10) || 10);
const watchAlerted = new Map(); // "siteId|spike" / "siteId|drop" → last alert ts
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? (s[s.length >> 1] + s[(s.length - 1) >> 1]) / 2 : 0; }
async function watchdogTick() {
  const now = Date.now();
  const hourStart = now - 3600e3;
  for (const site of allSites.all()) {
    const cur = db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND ts >= ? AND name IS NULL').get(site.id, hourStart).v;
    const hist = [];
    for (let d = 1; d <= 14; d++) {
      const s = hourStart - d * 864e5;
      hist.push(db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL').get(site.id, s, s + 3600e3).v);
    }
    const base = median(hist);
    // abstain when the baseline is too thin to mean anything — a default is not a measurement
    if (base < WATCH_MIN_VISITORS && cur < WATCH_MIN_VISITORS) continue;
    let kind = null, emoji = '', text = '';
    if (base >= 1 && cur >= Math.max(3 * base, base + WATCH_MIN_VISITORS)) { kind = 'spike'; emoji = '🚀'; text = `traffic spike: **${cur}** visitors last hour (usually ~${base})`; }
    else if (base >= WATCH_MIN_VISITORS && cur <= base * 0.2) { kind = 'drop'; emoji = '📉'; text = `traffic drop: **${cur}** visitors last hour (usually ~${base}) — tracker offline?`; }
    if (!kind) continue;
    const key = site.id + '|' + kind;
    if (now - (watchAlerted.get(key) || 0) < 6 * 3600e3) continue; // cooldown
    watchAlerted.set(key, now);
    try {
      await fetch(DIGEST_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Nyx Analytics 🦞', content: `${emoji} **${site.domain}** ${text}` }) });
    } catch (e) { console.error('watchdog webhook error:', e.message); }
  }
}
if (DIGEST_WEBHOOK_URL) setInterval(watchdogTick, 3600e3).unref();

app.listen(PORT, '127.0.0.1', () => console.log(`Nyx Analytics 🦞 on http://127.0.0.1:${PORT}${RETENTION_DAYS ? ` · retention ${RETENTION_DAYS}d` : ''}${DIGEST_WEBHOOK_URL ? ` · digest ${DIGEST_HOUR_UTC}:00 UTC` : ''}`));
