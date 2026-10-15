'use strict';
/* Tacilytics — importers for historical data.
 *
 * Imported data is daily aggregates, never visitor rows: one row per (day, dimension, value).
 *   dim ''        → totals of the day      dim 'page'    → path
 *   dim 'source'  → referrer / source      dim 'country' → ISO-2 code
 *   dim 'browser' | 'os' | 'device'        dim 'event'   → custom event name
 *
 * Supported inputs
 *   - Plausible: the export ZIP (Site settings → Imports & Exports → Export) or its CSV files.
 *     Format: https://plausible.io/docs/csv-import
 *   - Google Analytics 4: CSV downloads of reports / explorations that have a DATE column,
 *     optionally one more dimension (page path, session source, country, browser, device
 *     category, operating system, event name). English or German column names.
 */
const zlib = require('zlib');

// ── CSV (RFC 4180: quotes, doubled quotes, newlines inside quotes) ──
function parseCSV(text) {
  const s = String(text).replace(/^\uFEFF/, '');
  // separator = whichever of , ; TAB appears most in the first line (outside quotes)
  const first = s.slice(0, s.search(/\r?\n/) >>> 0 || s.length).replace(/"[^"]*"/g, '');
  const sep = [',', ';', '\t'].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

// ── ZIP (stored + deflate, via the central directory; enough for analytics exports) ──
function unzip(buf, { maxFiles = 50, maxBytes = 200 * 1024 * 1024 } = {}) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new Error(`Too many files in the ZIP (${count})`);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken ZIP directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    total += usize;
    if (total > maxBytes) throw new Error('ZIP content is too large');
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    let content;
    if (method === 0) content = data;
    else if (method === 8) content = zlib.inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) + 1024 });
    else throw new Error('Unsupported ZIP compression in ' + name);
    out.push({ name: name.split('/').pop(), text: content.toString('utf8') });
  }
  return out;
}

function int(v) {
  let t = String(v == null ? '' : v).trim().replace(/\s/g, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, '');   // 1.234 / 1,234 = thousand separators
  else t = t.replace(',', '.');
  const n = Math.round(Number(t));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function normDay(v) {
  const s = String(v || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;           // GA4: 20261015
  if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // 15.10.2026
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; // 10/15/2026
  return null;
}
const validDay = (d) => d && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const DEVICE = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop', laptop: 'Desktop', smarttv: 'Desktop', 'smart tv': 'Desktop' };
const normDevice = (d) => DEVICE[String(d || '').toLowerCase()] || (d ? String(d) : null);
function normSource(s) {
  const v = String(s || '').trim();
  if (!v || /^\(?(direct|none|not set)\)?$/i.test(v) || v === '(direct)') return 'Direct';
  return v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase().slice(0, 120) || 'Direct';
}
// country names GA4 writes in place of codes (most common ones; unknown names are kept)
const COUNTRY = { germany: 'DE', deutschland: 'DE', austria: 'AT', österreich: 'AT', switzerland: 'CH', schweiz: 'CH', 'united states': 'US', 'vereinigte staaten': 'US', 'united kingdom': 'GB', 'vereinigtes königreich': 'GB', france: 'FR', frankreich: 'FR', netherlands: 'NL', niederlande: 'NL', italy: 'IT', italien: 'IT', spain: 'ES', spanien: 'ES', poland: 'PL', polen: 'PL', belgium: 'BE', belgien: 'BE', luxembourg: 'LU', luxemburg: 'LU', denmark: 'DK', dänemark: 'DK', sweden: 'SE', schweden: 'SE', norway: 'NO', norwegen: 'NO', 'czech republic': 'CZ', czechia: 'CZ', tschechien: 'CZ', canada: 'CA', kanada: 'CA', australia: 'AU', australien: 'AU' };
const normCountry = (c) => { const v = String(c || '').trim(); if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase(); return COUNTRY[v.toLowerCase()] || v.slice(0, 60) || null; };

// ── Plausible ──
const PLAUSIBLE = {
  imported_visitors: (r) => ({ dim: '', name: '', visitors: int(r.visitors), pageviews: int(r.pageviews), visits: int(r.visits), bounces: int(r.bounces), duration: int(r.visit_duration) }),
  imported_pages: (r) => ({ dim: 'page', name: r.path || r.page, visitors: int(r.visitors), pageviews: int(r.pageviews) }),
  imported_sources: (r) => ({ dim: 'source', name: normSource(r.source || r.referrer), visitors: int(r.visitors), pageviews: int(r.pageviews) }),
  imported_locations: (r) => ({ dim: 'country', name: normCountry(r.country), visitors: int(r.visitors), pageviews: int(r.pageviews) }),
  imported_browsers: (r) => ({ dim: 'browser', name: r.browser, visitors: int(r.visitors), pageviews: int(r.pageviews) }),
  imported_operating_systems: (r) => ({ dim: 'os', name: r.operating_system, visitors: int(r.visitors), pageviews: int(r.pageviews) }),
  imported_devices: (r) => ({ dim: 'device', name: normDevice(r.device), visitors: int(r.visitors), pageviews: int(r.pageviews) }),
  imported_custom_events: (r) => ({ dim: 'event', name: r.name, visitors: int(r.visitors), pageviews: int(r.events) }),
};
function fromPlausible(files) {
  const rows = []; const used = [];
  for (const f of files) {
    const kind = Object.keys(PLAUSIBLE).find((k) => f.name.startsWith(k + '_') || f.name === k + '.csv');
    if (!kind) continue;
    const table = parseCSV(f.text);
    if (table.length < 2) continue;
    const head = table[0].map((h) => h.trim().toLowerCase());
    for (const line of table.slice(1)) {
      const r = Object.fromEntries(head.map((h, i) => [h, line[i]]));
      const day = normDay(r.date);
      if (!validDay(day)) continue;
      // Plausible stores custom-event props in sub-rows; we aggregate per event name
      const x = PLAUSIBLE[kind](r);
      if (x.dim !== '' && !x.name) continue;
      rows.push({ day, ...x, name: String(x.name || '').slice(0, 300) });
    }
    used.push(kind);
  }
  if (!used.length) throw new Error('No Plausible CSV files found (names like imported_visitors_20240101_20241231.csv)');
  return { rows, files: used };
}

// ── Google Analytics 4 (CSV downloads) ──
const GA_COL = {
  date: ['date', 'datum', 'day', 'tag'],
  users: ['total users', 'users', 'active users', 'nutzer insgesamt', 'nutzer', 'aktive nutzer', 'totalusers', 'activeusers'],
  views: ['views', 'screen page views', 'aufrufe', 'seitenaufrufe', 'screenpageviews', 'pageviews', 'event count', 'ereignisanzahl', 'anzahl der ereignisse', 'eventcount'],
  sessions: ['sessions', 'sitzungen'],
  bounce: ['bounce rate', 'absprungrate'],
};
const GA_DIM = [
  ['page', ['page path and screen class', 'page path', 'seitenpfad und bildschirmklasse', 'seitenpfad', 'pagepath', 'landing page', 'landingpage', 'zielseite', 'page location', 'seitenpfad + abfragestring', 'page path + query string']],
  ['source', ['session source', 'source', 'sitzungsquelle', 'quelle', 'session source / medium', 'sitzungsquelle/-medium', 'first user source', 'quelle der ersten nutzer']],
  ['country', ['country', 'land', 'country id', 'länder-id']],
  ['browser', ['browser']],
  ['os', ['operating system', 'betriebssystem', 'operatingsystem']],
  ['device', ['device category', 'gerätekategorie', 'devicecategory']],
  ['event', ['event name', 'ereignisname', 'eventname']],
];
function fromGA(files) {
  const rows = []; const used = [];
  for (const f of files) {
    // GA4 puts "# ----" comment blocks above (and between) tables
    const lines = String(f.text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
    const table = parseCSV(lines.join('\n'));
    if (table.length < 2) continue;
    const head = table[0].map((h) => h.trim().toLowerCase());
    const col = (names) => head.findIndex((h) => names.includes(h));
    const di = col(GA_COL.date);
    if (di < 0) continue;
    const ui = col(GA_COL.users), vi = col(GA_COL.views), si = col(GA_COL.sessions);
    if (ui < 0 && vi < 0) continue;
    let dim = '', xi = -1;
    for (const [d, names] of GA_DIM) { const i = col(names); if (i >= 0) { dim = d; xi = i; break; } }
    for (const line of table.slice(1)) {
      const day = normDay(line[di]);
      if (!validDay(day)) continue; // GA4 adds a "Grand total" line without a date
      let name = xi >= 0 ? String(line[xi] || '').trim() : '';
      if (dim === 'source') name = normSource(name.split('/')[0]);
      if (dim === 'country') name = normCountry(name);
      if (dim === 'device') name = normDevice(name);
      if (dim === 'page') { try { if (/^https?:/.test(name)) name = new URL(name).pathname; } catch {} }
      if (dim && (!name || /^\(not set\)$/i.test(name))) continue;
      const visitors = ui >= 0 ? int(line[ui]) : 0;
      const pageviews = vi >= 0 ? int(line[vi]) : 0;
      rows.push({ day, dim, name: name.slice(0, 300), visitors, pageviews, visits: si >= 0 ? int(line[si]) : 0 });
    }
    used.push(f.name + (dim ? ` (${dim})` : ' (totals)'));
  }
  if (!used.length) throw new Error('No usable Google Analytics CSV found — the report needs a Date column (add "Date" as a dimension) and Users or Views');
  return { rows, files: used };
}

/** merge duplicate (day, dim, name) rows by summing — GA "source / medium" splits one source over many rows */
function aggregate(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.day + '\u0001' + r.dim + '\u0001' + r.name;
    const e = m.get(k);
    if (!e) m.set(k, { ...r, visits: r.visits || 0, bounces: r.bounces || 0, duration: r.duration || 0 });
    else { e.visitors += r.visitors; e.pageviews += r.pageviews; e.visits += r.visits || 0; e.bounces += r.bounces || 0; e.duration += r.duration || 0; }
  }
  return [...m.values()];
}

/** GA4 often has no "totals" file: derive daily totals from the best single dimension if missing */
function ensureTotals(rows) {
  if (rows.some((r) => r.dim === '')) return rows;
  const pick = ['device', 'country', 'browser', 'os', 'source', 'page'].find((d) => rows.some((r) => r.dim === d));
  if (!pick) return rows;
  const tot = new Map();
  for (const r of rows) if (r.dim === pick) {
    const e = tot.get(r.day) || { day: r.day, dim: '', name: '', visitors: 0, pageviews: 0, visits: 0, bounces: 0, duration: 0 };
    e.visitors += r.visitors; e.pageviews += r.pageviews; tot.set(r.day, e);
  }
  return rows.concat([...tot.values()]);
}

function parseImport(source, input) {
  // input: { zip: Buffer } or { files: [{ name, text }] }
  let files = input.files || [];
  if (input.zip) files = unzip(input.zip);
  if (!files.length) throw new Error('No files');
  const r = source === 'plausible' ? fromPlausible(files) : source === 'ga' ? fromGA(files) : null;
  if (!r) throw new Error('source must be plausible or ga');
  return { rows: ensureTotals(aggregate(r.rows)), files: r.files };
}

module.exports = { parseImport, _test: { parseCSV, unzip, int, normDay, normSource, normCountry, aggregate, ensureTotals } };
