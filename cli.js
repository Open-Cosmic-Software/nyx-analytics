#!/usr/bin/env node
/* Nyx Analytics CLI 🦞 — query your analytics from the terminal or an agent.
 *
 *   export NYX_URL=https://analytics.example.com
 *   export NYX_API_KEY=nyx_xxx
 *   nyx sites
 *   nyx stats example.com 30d
 *   nyx live example.com --watch
 *   nyx add example.com
 *
 * Add --json to any command for raw machine-readable output (for agents).
 */
'use strict';

const URL_BASE = (process.env.NYX_URL || 'https://analytics.heynyx.dev').replace(/\/$/, '');
const KEY = process.env.NYX_API_KEY || '';
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const WATCH = args.includes('--watch');
const pos = args.filter((a) => !a.startsWith('--'));
const cmd = pos[0];
// --key=value flags → extra query params (filters: country,source,page,browser,os,device,lang,medium,campaign,goal · range: from,to)
const flags = {};
args.filter((a) => a.startsWith('--') && a.includes('=')).forEach((a) => { const i = a.indexOf('='); flags[a.slice(2, i)] = a.slice(i + 1); });
function extraQuery() { return Object.keys(flags).filter((k) => k !== 'json' && k !== 'watch').map((k) => '&' + encodeURIComponent(k) + '=' + encodeURIComponent(flags[k])).join(''); }
const fmtDur = (s) => (s == null ? '—' : s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : ''));

// ── tiny ANSI helpers ──
const C = process.stdout.isTTY && !JSON_OUT;
const c = (n, s) => (C ? `\x1b[${n}m${s}\x1b[0m` : s);
const pink = (s) => c('38;5;211', s), purple = (s) => c('38;5;141', s), cyan = (s) => c('38;5;87', s);
const dim = (s) => c('2', s), bold = (s) => c('1', s), green = (s) => c('38;5;120', s), red = (s) => c('38;5;210', s);

function die(msg) { console.error(red('✖ ' + msg)); process.exit(1); }

async function api(path) {
  if (!KEY) die('Set NYX_API_KEY (and optionally NYX_URL).');
  const res = await fetch(URL_BASE + path, { headers: { Authorization: 'Bearer ' + KEY } });
  if (res.status === 401) die('Unauthorized — check NYX_API_KEY.');
  const j = await res.json().catch(() => ({}));
  if (!res.ok) die(j.error || ('HTTP ' + res.status));
  return j;
}
async function post(path, body) {
  if (!KEY) die('Set NYX_API_KEY (and optionally NYX_URL).');
  const res = await fetch(URL_BASE + path, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) die(j.error || ('HTTP ' + res.status));
  return j;
}

const flag = (cc) => (cc && cc.length === 2 ? cc.toUpperCase().replace(/./g, (x) => String.fromCodePoint(127397 + x.charCodeAt(0))) : '🌐');
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
function bar(rows, key) {
  if (!rows || !rows.length) return '  ' + dim('(none)');
  const max = Math.max.apply(null, rows.map((r) => r[key] || 0)) || 1;
  return rows.map((r) => {
    const w = Math.round(((r[key] || 0) / max) * 22);
    return '  ' + pad(r.label || r.name, 30) + ' ' + purple('▇'.repeat(w) || '▏') + ' ' + bold(r[key]);
  }).join('\n');
}

function banner(t) { if (!JSON_OUT) console.log('\n' + pink('🦞 ') + bold(t)); }

async function cmdSites() {
  const sites = await api('/api/v1/sites');
  if (JSON_OUT) return console.log(JSON.stringify(sites, null, 2));
  banner('Sites');
  if (!sites.length) return console.log('  ' + dim('No sites yet. Add one:  nyx add example.com'));
  sites.forEach((s) => console.log('  ' + cyan(pad(s.domain, 28)) + dim('  id ' + s.id)));
}

async function cmdStats() {
  const domain = pos[1] || die('Usage: nyx stats <domain> [period] [--country=DE] [--from=YYYY-MM-DD --to=YYYY-MM-DD]');
  const period = pos[2] || '7d';
  const range = flags.from && flags.to ? '' : `&period=${period}`;
  const s = await api(`/api/v1/stats?site=${encodeURIComponent(domain)}${range}${extraQuery()}`);
  if (JSON_OUT) return console.log(JSON.stringify(s, null, 2));
  const t = s.totals, tr = s.trend || {};
  const trend = (v) => (v == null ? '' : ' ' + (v >= 0 ? green('▲' + v + '%') : red('▼' + Math.abs(v) + '%')));
  const label = s.range ? `${s.range.from} → ${s.range.to}` : period;
  banner(`${domain}  ·  ${label}`);
  const active = Object.keys(s.filters || {});
  if (active.length) console.log('  ' + dim('filtered by ' + active.map((k) => k + '=' + s.filters[k]).join(', ')));
  console.log('  ' + pad('Visitors', 16) + bold(t.visitors) + trend(tr.visitors));
  console.log('  ' + pad('Pageviews', 16) + bold(t.pageviews) + trend(tr.pageviews));
  console.log('  ' + pad('Bounce', 16) + bold(t.bounce + '%'));
  console.log('  ' + pad('Views/visitor', 16) + bold(t.viewsPerVisitor));
  console.log('  ' + pad('Avg. visit time', 16) + bold(fmtDur(t.duration)));
  console.log('\n' + dim('  Top pages')); console.log(bar(s.pages, 'visitors'));
  if (s.entryPages && s.entryPages.length) { console.log('\n' + dim('  Entry pages')); console.log(bar(s.entryPages, 'visitors')); }
  console.log('\n' + dim('  Sources')); console.log(bar(s.sources, 'visitors'));
  if (s.campaigns && s.campaigns.length) { console.log('\n' + dim('  Campaigns')); console.log(bar(s.campaigns, 'visitors')); }
  console.log('\n' + dim('  Locations')); console.log(bar((s.countries || []).map((r) => ({ name: flag(r.name) + ' ' + r.name, visitors: r.visitors })), 'visitors'));
  if (s.goals && s.goals.length) {
    console.log('\n' + dim('  Goals  ' + dim('(conversion)')));
    console.log(bar(s.goals.map((g) => ({ name: g.name + dim('  ' + (g.cr != null ? g.cr + '%' : '')), visitors: g.visitors })), 'visitors'));
  }
}

async function renderLive(domain) {
  const r = await api(`/api/v1/realtime?site=${encodeURIComponent(domain)}`);
  if (JSON_OUT) return console.log(JSON.stringify(r, null, 2));
  if (WATCH) process.stdout.write('\x1b[2J\x1b[H'); // clear
  banner(`Live · ${domain}`);
  console.log('  ' + green('● ') + bold(r.online) + ' online now' + dim('  (last 5 min)'));
  const spark = '▁▂▃▄▅▆▇█';
  const max = Math.max.apply(null, r.minutes.map((m) => m.pageviews).concat([1]));
  const line = r.minutes.map((m) => (m.pageviews ? spark[Math.min(7, Math.round((m.pageviews / max) * 7))] : dim('·'))).join('');
  console.log('  ' + purple(line) + dim('  ← 30 min'));
  console.log('\n' + dim('  Recent activity'));
  if (!r.recent.length) return console.log('  ' + dim('(quiet)'));
  r.recent.slice(0, 20).forEach((e) => {
    const ago = Math.round((r.now - e.ts) / 1000);
    const t = ago < 8 ? 'now' : ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm';
    const what = e.name ? pink('🎯 ' + e.name) : e.path;
    const src = e.source && e.source !== 'Direct' ? dim(' ↗ ' + e.source) : '';
    console.log('  ' + flag(e.country) + ' ' + pad(what, 32) + ' ' + dim(pad((e.browser || '') + ' · ' + (e.device || ''), 20)) + src + dim('  ' + t));
  });
}
async function cmdLive() {
  const domain = pos[1] || die('Usage: nyx live <domain> [--watch]');
  await renderLive(domain);
  if (WATCH && !JSON_OUT) setInterval(() => renderLive(domain).catch(() => {}), 5000);
}

async function cmdAdd() {
  const domain = pos[1] || die('Usage: nyx add <domain>');
  const s = await post('/api/v1/sites', { domain });
  if (JSON_OUT) return console.log(JSON.stringify(s, null, 2));
  banner('Site added: ' + s.domain);
  console.log('\n  Embed this in your site <head>:\n');
  console.log('  ' + cyan(`<script defer data-domain="${s.domain}" src="${URL_BASE}/nyx.js"></script>`));
}

function help() {
  console.log(`
${pink('🦞 Nyx Analytics CLI')}

${bold('Usage')}  nyx <command> [--json] [--watch]

  ${cyan('sites')}                     list tracked sites
  ${cyan('stats')} <domain> [period]   key metrics + breakdowns (today|7d|30d|90d|12mo)
  ${cyan('live')} <domain> [--watch]   online visitors + last-30-min feed
  ${cyan('add')} <domain>              add a site, print the embed snippet

${bold('Segment & range')} (on stats)
  ${dim('--country=DE --source=… --page=… --browser=… --medium=… --campaign=… --goal=…')}
  ${dim('--from=2026-01-01 --to=2026-01-31')}   custom date range

${bold('Config')} (env)
  NYX_URL       ${dim(URL_BASE)}
  NYX_API_KEY   ${KEY ? green('set') : red('not set')}

${dim('Add --json for machine-readable output (agents).')}
`);
}

(async () => {
  try {
    if (cmd === 'sites') await cmdSites();
    else if (cmd === 'stats') await cmdStats();
    else if (cmd === 'live' || cmd === 'realtime') await cmdLive();
    else if (cmd === 'add') await cmdAdd();
    else help();
  } catch (e) { die(e.message || String(e)); }
})();
