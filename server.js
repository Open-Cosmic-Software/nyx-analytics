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
// migration: custom-event name column (for installs created before goals existed)
if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'name')) db.exec('ALTER TABLE events ADD COLUMN name TEXT');

const norm = (d) => String(d || '').toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '').trim();
const getSiteByDomain = db.prepare('SELECT * FROM sites WHERE domain = ?');
const insSite = db.prepare('INSERT OR IGNORE INTO sites (domain, name, created) VALUES (?, ?, ?)');
const allSites = db.prepare('SELECT * FROM sites ORDER BY domain');
const insEvent = db.prepare(`INSERT INTO events (site_id, ts, day, path, source, referrer, country, tz, browser, os, device, lang, name, vh)
  VALUES (@site_id, @ts, @day, @path, @source, @referrer, @country, @tz, @browser, @os, @device, @lang, @name, @vh)`);

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
  // referrer → source host
  let referrer = String(b.r || b.referrer || '').slice(0, 512);
  let source = 'Direct';
  const utm = String(b.s || b.utm || '').slice(0, 60);
  if (utm) source = utm;
  else if (referrer) {
    try { const h = norm(new URL(referrer).hostname); if (h && h !== domain) source = h; } catch {}
  }
  const tz = String(b.tz || '').slice(0, 60) || null;
  const lang = String(b.l || b.lang || '').slice(0, 12).split(',')[0] || null;
  const name = String(b.n || b.name || '').slice(0, 80).trim() || null; // custom event / goal
  const ip = clientIp(req);
  insEvent.run({
    site_id: site.id, ts, day, path: pth, source, referrer: referrer || null,
    country: countryFromTz(tz), tz, browser: ua.browser, os: ua.os, device: ua.device,
    lang, name, vh: visitorHash(site.id, ip, req.headers['user-agent'] || '', day),
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
    'GET /api/v1/stats?site=&period=': 'aggregated stats (period: today|7d|30d|90d|12mo)',
    'GET /api/v1/realtime?site=': 'online count, last-30-min pulse + recent events',
  },
}));
app.get('/api/v1/sites', auth, sitesListHandler);
app.post('/api/v1/sites', auth, sitesCreateHandler);

// ── stats ────────────────────────────────────────────────────────────────────
const PERIODS = { today: 1, '7d': 7, '30d': 30, '90d': 90, '12mo': 365 };
function rangeFor(period) {
  const days = PERIODS[period] || 7;
  const now = Date.now();
  let start;
  if (period === 'today') start = new Date(new Date(now).toISOString().slice(0, 10)).getTime();
  else start = now - days * 864e5;
  return { start, end: now, days };
}
function statsHandler(req, res) {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  const period = req.query.period || '7d';
  const { start, days } = rangeFor(period);
  const sid = site.id;
  const where = 'site_id = ? AND ts >= ? AND name IS NULL'; // pageviews only (custom events excluded)
  const args = [sid, start];

  const totals = db.prepare(`SELECT COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE ${where}`).get(...args);
  // bounce: visitors with exactly 1 pageview in the range
  const bounceRow = db.prepare(`SELECT COUNT(*) AS bounced FROM (SELECT vh, COUNT(*) c FROM events WHERE ${where} GROUP BY vh HAVING c = 1)`).get(...args);
  const bounce = totals.visitors ? Math.round((bounceRow.bounced / totals.visitors) * 100) : 0;
  const viewsPerVisitor = totals.visitors ? +(totals.pageviews / totals.visitors).toFixed(1) : 0;
  // trend vs the previous equal-length window
  const len = Date.now() - start;
  const prev = db.prepare('SELECT COUNT(*) pageviews, COUNT(DISTINCT vh) visitors FROM events WHERE site_id = ? AND name IS NULL AND ts >= ? AND ts < ?').get(sid, start - len, start);
  const pct = (cur, was) => (was ? Math.round(((cur - was) / was) * 100) : null);

  // time series (per hour for today, else per day)
  let series;
  if (period === 'today') {
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
      const d = new Date(Date.now() - (days - 1 - i) * 864e5).toISOString().slice(0, 10);
      const r = map.get(d);
      return { label: d.slice(5), day: d, visitors: r ? r.v : 0, pageviews: r ? r.pv : 0 };
    });
  }

  const topBy = (col, limit = 8) => db.prepare(
    `SELECT ${col} AS name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE ${where} AND ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY visitors DESC, pageviews DESC LIMIT ${limit}`,
  ).all(...args);

  const goals = db.prepare(
    'SELECT name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE site_id = ? AND ts >= ? AND name IS NOT NULL GROUP BY name ORDER BY visitors DESC, pageviews DESC LIMIT 8',
  ).all(sid, start);

  res.json({
    site: { domain: site.domain, name: site.name },
    period,
    totals: { visitors: totals.visitors, pageviews: totals.pageviews, bounce, viewsPerVisitor },
    trend: { visitors: pct(totals.visitors, prev.visitors), pageviews: pct(totals.pageviews, prev.pageviews) },
    series,
    pages: topBy('path', 10),
    sources: topBy('source', 8),
    countries: topBy('country', 8),
    browsers: topBy('browser', 6),
    os: topBy('os', 6),
    devices: topBy('device', 4),
    languages: topBy('lang', 6),
    goals,
    realtime: db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND name IS NULL AND ts >= ?').get(sid, Date.now() - 5 * 60000).v,
  });
}
app.get('/api/stats', auth, statsHandler);
app.get('/api/v1/stats', auth, statsHandler);

// ── realtime: live visitors + per-minute pulse + recent event feed (last 30 min) ──
function realtimeHandler(req, res) {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  const sid = site.id, now = Date.now(), since = now - 30 * 60000;
  const online = db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND name IS NULL AND ts >= ?').get(sid, now - 5 * 60000).v;
  const rows = db.prepare('SELECT CAST((ts/60000) AS INT) b, COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND name IS NULL AND ts >= ? GROUP BY b').all(sid, since);
  const map = new Map(rows.map((r) => [r.b, r]));
  const startB = Math.floor(since / 60000);
  const minutes = Array.from({ length: 30 }, (_, i) => { const r = map.get(startB + i + 1); return { visitors: r ? r.v : 0, pageviews: r ? r.pv : 0 }; });
  const recent = db.prepare('SELECT ts, path, country, tz, browser, os, device, source, lang, name FROM events WHERE site_id = ? AND ts >= ? ORDER BY id DESC LIMIT 60').all(sid, since);
  res.json({ online, minutes, recent, now });
}
app.get('/api/realtime', auth, realtimeHandler);
app.get('/api/v1/realtime', auth, realtimeHandler);

// ── static dashboard ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '127.0.0.1', () => console.log(`Nyx Analytics 🦞 on http://127.0.0.1:${PORT}`));
