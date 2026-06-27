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

const norm = (d) => String(d || '').toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '').trim();
const getSiteByDomain = db.prepare('SELECT * FROM sites WHERE domain = ?');
const insSite = db.prepare('INSERT OR IGNORE INTO sites (domain, name, created) VALUES (?, ?, ?)');
const allSites = db.prepare('SELECT * FROM sites ORDER BY domain');
const insEvent = db.prepare(`INSERT INTO events (site_id, ts, day, path, source, referrer, country, tz, browser, os, device, lang, name, utm_medium, utm_campaign, dur, props, vh)
  VALUES (@site_id, @ts, @day, @path, @source, @referrer, @country, @tz, @browser, @os, @device, @lang, @name, @utm_medium, @utm_campaign, @dur, @props, @vh)`);
// engagement: attach a visit duration (seconds) to the visitor's most recent pageview for that path.
const updDur = db.prepare(`UPDATE events SET dur = @dur WHERE id = (
  SELECT id FROM events WHERE site_id = @site_id AND vh = @vh AND name IS NULL AND path = @path AND ts >= @since
  ORDER BY id DESC LIMIT 1) AND (dur IS NULL OR dur < @dur)`);

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

  // engagement beacon: attach a visit duration to the visitor's latest pageview (no new row).
  if (b.e === 'engagement') {
    const dur = Math.max(0, Math.min(7200, parseInt(b.dur, 10) || 0)); // cap at 2h
    if (dur > 0) updDur.run({ site_id: site.id, vh, path: pth, dur, since: ts - 6 * 3600000 });
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
  const sid = site.id;
  const { start, end, days, period, hourly } = rangeFor(req.query);
  const { clauses, params, goal } = buildFilters(req.query);

  // pageview WHERE = time window + segmentation filters. A goal filter narrows the visitor
  // set to those who fired that event in-range (so every breakdown reflects converters only).
  let where = 'site_id = ? AND ts >= ? AND ts < ? AND name IS NULL';
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

  res.json({
    site: { domain: site.domain, name: site.name },
    period, range: { from: new Date(start).toISOString().slice(0, 10), to: new Date(end - 1).toISOString().slice(0, 10) },
    filters: Object.assign({}, ...Object.keys(FILTER_COLS).filter((k) => req.query[k]).map((k) => ({ [k]: req.query[k] })), goal ? { goal } : {}),
    totals: { visitors: totals.visitors, pageviews: totals.pageviews, bounce, viewsPerVisitor, duration },
    trend: { visitors: pct(totals.visitors, prev.visitors), pageviews: pct(totals.pageviews, prev.pageviews) },
    series,
    pages: topBy('path', 10),
    entryPages: edge('ASC', 8),
    exitPages: edge('DESC', 8),
    sources: topBy('source', 8),
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

app.listen(PORT, '127.0.0.1', () => console.log(`Nyx Analytics 🦞 on http://127.0.0.1:${PORT}${RETENTION_DAYS ? ` · retention ${RETENTION_DAYS}d` : ''}`));
