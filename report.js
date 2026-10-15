'use strict';
// Weekly report: numbers + e-mail (HTML and plain text), in English or German.
// Pure functions over the database; sending/scheduling stays in server.js.
//
// One block per site the person can see, covering the last 7 full UTC days compared with
// the 7 before: key figures, a day-by-day chart, highlights, pages, sources, countries,
// devices, goals, shop numbers and the notes of that week. HTML is table-based with inline
// styles only (mail clients drop <style> and flexbox), light design, max 600 px wide.

const DAY = 864e5;
const SOURCE_NAMES = {
  'com.google.android.googlequicksearchbox': 'Google App (Android)', 'com.google.android.gm': 'Gmail App',
  'fb': 'Facebook', 'm.facebook.com': 'Facebook (mobile)', 'l.facebook.com': 'Facebook', 'lm.facebook.com': 'Facebook',
  'ig': 'Instagram', 'l.instagram.com': 'Instagram', 'homescreen': 'Homescreen (app shortcut)',
  'android-app://com.google.android.googlequicksearchbox': 'Google App (Android)', 't.co': 'X / Twitter',
};

const TXT = {
  en: {
    weekly: 'Weekly report', compared: 'compared with the week before', hi: 'Hi', intro: 'here is how last week went.',
    allSites: 'All sites together', sitesN: 'Websites', visitors: 'Visitors', pageviews: 'Pageviews', bounce: 'Bounce rate', time: 'Avg. visit time',
    vpv: 'Views / visitor', days: 'Day by day', highlights: 'Highlights', pages: 'Top pages', sources: 'Top sources',
    countries: 'Countries', devices: 'Devices', goals: 'Goals', shop: 'Shop', orders: 'Orders', revenue: 'Revenue', aov: 'Avg. order',
    cr: 'Conversion rate', notes: 'Notes this week', open: 'Open the dashboard', bestDay: 'Best day', climber: 'Climbing',
    newSource: 'New source', newGoal: 'First time', more: 'more visitors than the week before', fewer: 'fewer visitors than the week before',
    same: 'as many visitors as the week before', direct: 'Direct / none', unknown: 'Unknown', desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet',
    quiet: 'A quiet week — no visitors.', compactNote: 'Smaller sites are shown briefly to keep this e-mail readable in every mail app — the dashboard has all details.', footer: "Cookieless analytics — we count, we don't tell.",
    off: 'You get this because you turned it on. Turn it off under Settings → Security → Weekly report.',
    subjOne: (d, v, p) => `${d}: ${v} visitors last week (${p})`, subjMany: (n, v, p) => `${n} sites: ${v} visitors last week (${p})`,
    new: 'new', noPrev: 'no data the week before', vs: 'vs.', min: 'min', s: 's', pp: 'pp',
    weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], locale: 'en-GB',
  },
  de: {
    weekly: 'Wochenbericht', compared: 'im Vergleich zur Vorwoche', hi: 'Hallo', intro: 'so lief die letzte Woche.',
    allSites: 'Alle Seiten zusammen', sitesN: 'Websites', visitors: 'Besucher', pageviews: 'Seitenaufrufe', bounce: 'Absprungrate', time: 'Ø Besuchsdauer',
    vpv: 'Aufrufe / Besucher', days: 'Tag für Tag', highlights: 'Auffällig', pages: 'Top-Seiten', sources: 'Top-Quellen',
    countries: 'Länder', devices: 'Geräte', goals: 'Ziele', shop: 'Shop', orders: 'Bestellungen', revenue: 'Umsatz', aov: 'Ø Bestellwert',
    cr: 'Conversion-Rate', notes: 'Notizen dieser Woche', open: 'Dashboard öffnen', bestDay: 'Bester Tag', climber: 'Im Aufwind',
    newSource: 'Neue Quelle', newGoal: 'Zum ersten Mal', more: 'mehr Besucher als in der Vorwoche', fewer: 'weniger Besucher als in der Vorwoche',
    same: 'genauso viele Besucher wie in der Vorwoche', direct: 'Direkt / keine', unknown: 'Unbekannt', desktop: 'Desktop', mobile: 'Mobil', tablet: 'Tablet',
    quiet: 'Eine ruhige Woche, keine Besucher.', compactNote: 'Kleinere Seiten stehen hier nur kurz, damit die Mail in jedem Mailprogramm vollständig angezeigt wird. Alle Details im Dashboard.', footer: 'Analyse ohne Cookies · wir zählen, wir verraten nichts.',
    off: 'Du bekommst diese Mail, weil du sie eingeschaltet hast. Abschalten unter Einstellungen → Sicherheit → Wochenbericht.',
    subjOne: (d, v, p) => `${d}: ${v} Besucher letzte Woche (${p})`, subjMany: (n, v, p) => `${n} Seiten: ${v} Besucher letzte Woche (${p})`,
    new: 'neu', noPrev: 'keine Daten in der Vorwoche', vs: 'ggü.', min: 'Min.', s: 's', pp: 'Pp.',
    weekdays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], locale: 'de-DE',
  },
};

const C = { bg: '#eef4f3', card: '#ffffff', line: '#dbe7e5', text: '#0f2624', dim: '#4b6662', faint: '#7c918e', teal: '#0f9e8e', tealSoft: '#d5f0ec', up: '#0f8a5f', down: '#c2410c', coral: '#ff7a5c' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌐');

function createReport(db, { paymentHosts = [] } = {}) {
  const NOT_INTERNAL = 'NOT EXISTS (SELECT 1 FROM internal_vh i WHERE i.site_id = events.site_id AND i.vh = events.vh AND i.day = events.day)';
  const PV = `site_id = ? AND ts >= ? AND ts < ? AND name IS NULL AND ${NOT_INTERNAL}`;
  const EV = `site_id = ? AND ts >= ? AND ts < ? AND name IS NOT NULL AND ${NOT_INTERNAL}`;
  const q = {
    totals: db.prepare(`SELECT COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE ${PV}`),
    bounced: db.prepare(`SELECT COUNT(*) n FROM (SELECT vh FROM events WHERE ${PV} GROUP BY vh HAVING COUNT(*) = 1)`),
    dur: db.prepare(`SELECT AVG(dur) d FROM events WHERE ${PV} AND dur IS NOT NULL`),
    days: db.prepare(`SELECT day, COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE ${PV} GROUP BY day`),
    pages: db.prepare(`SELECT path k, COUNT(DISTINCT vh) v, COUNT(*) pv FROM events WHERE ${PV} GROUP BY path ORDER BY v DESC, pv DESC LIMIT 50`),
    sources: db.prepare(`SELECT COALESCE(NULLIF(source, ''), 'Direct') k, COUNT(DISTINCT vh) v FROM events WHERE ${PV} GROUP BY k ORDER BY v DESC LIMIT 50`),
    countries: db.prepare(`SELECT COALESCE(NULLIF(country, ''), '?') k, COUNT(DISTINCT vh) v FROM events WHERE ${PV} GROUP BY k ORDER BY v DESC LIMIT 6`),
    devices: db.prepare(`SELECT COALESCE(NULLIF(device, ''), '?') k, COUNT(DISTINCT vh) v FROM events WHERE ${PV} GROUP BY k ORDER BY v DESC`),
    goals: db.prepare(`SELECT name k, COUNT(*) c, COUNT(DISTINCT vh) v FROM events WHERE ${EV} GROUP BY name ORDER BY c DESC LIMIT 50`),
    purchases: db.prepare(`SELECT COUNT(*) n, SUM(CAST(json_extract(props, '$.value') AS REAL)) r, COUNT(DISTINCT vh || day) buyers FROM events WHERE ${EV.replace('name IS NOT NULL', "name = 'Purchase'")}`),
    notes: db.prepare('SELECT day, text FROM annotations WHERE site_id = ? AND day >= ? AND day <= ? ORDER BY day, id'),
  };
  void paymentHosts;

  function windowStats(sid, a, b) {
    const t = q.totals.get(sid, a, b);
    const bounced = t.v ? q.bounced.get(sid, a, b).n : 0;
    const d = q.dur.get(sid, a, b).d;
    return { v: t.v, pv: t.pv, bounce: t.v ? Math.round((bounced / t.v) * 100) : null, dur: d == null ? null : Math.round(d), vpv: t.v ? +(t.pv / t.v).toFixed(1) : null };
  }
  const toMap = (rows, f = 'v') => new Map(rows.map((r) => [r.k, r[f]]));

  function siteWeek(sid, now) {
    const today = new Date(now);
    const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const a = end - 7 * DAY, p = end - 14 * DAY;
    const cur = windowStats(sid, a, end), prev = windowStats(sid, p, a);
    const dayRows = new Map(q.days.all(sid, a, end).map((r) => [r.day, r]));
    const prevDayRows = new Map(q.days.all(sid, p, a).map((r) => [r.day, r]));
    const days = [];
    for (let t = a; t < end; t += DAY) {
      const k = new Date(t).toISOString().slice(0, 10), pk = new Date(t - 7 * DAY).toISOString().slice(0, 10);
      days.push({ day: k, dow: new Date(t).getUTCDay(), v: (dayRows.get(k) || {}).v || 0, pv: (dayRows.get(k) || {}).pv || 0, prevV: (prevDayRows.get(pk) || {}).v || 0 });
    }
    const pagesPrev = toMap(q.pages.all(sid, p, a));
    const pages = q.pages.all(sid, a, end).map((r) => ({ ...r, prev: pagesPrev.get(r.k) || 0 }));
    const srcPrev = toMap(q.sources.all(sid, p, a));
    const sources = q.sources.all(sid, a, end).map((r) => ({ ...r, prev: srcPrev.get(r.k) || 0 }));
    const goalsPrev = toMap(q.goals.all(sid, p, a), 'c');
    const goals = q.goals.all(sid, a, end).filter((g) => g.k !== 'Purchase').map((r) => ({ ...r, prev: goalsPrev.get(r.k) || 0 }));
    const pc = q.purchases.get(sid, a, end), pp = q.purchases.get(sid, p, a);
    const shop = pc.n ? { orders: pc.n, prevOrders: pp.n, revenue: +(pc.r || 0).toFixed(2), prevRevenue: +(pp.r || 0).toFixed(2), cr: cur.v ? +((pc.buyers / cur.v) * 100).toFixed(2) : 0 } : null;
    // highlights: only when they say something (thresholds keep noise out of small sites)
    const best = days.reduce((m, d) => (d.v > m.v ? d : m), days[0]);
    const climber = pages.filter((x) => x.v >= 5).map((x) => ({ ...x, gain: x.v - x.prev })).sort((x, y) => y.gain - x.gain)[0];
    const newSource = sources.find((x) => x.prev === 0 && x.v >= 3 && x.k !== 'Direct');
    const newGoal = goals.find((x) => x.prev === 0 && x.c >= 1);
    return {
      from: new Date(a).toISOString().slice(0, 10), to: new Date(end - DAY).toISOString().slice(0, 10),
      cur, prev, days, pages: pages.slice(0, 5), sources: sources.slice(0, 5),
      countries: q.countries.all(sid, a, end), devices: q.devices.all(sid, a, end), goals: goals.slice(0, 5), shop,
      notes: q.notes.all(sid, new Date(a).toISOString().slice(0, 10), new Date(end - DAY).toISOString().slice(0, 10)),
      highlights: {
        best: best && best.v ? best : null,
        climber: climber && climber.gain >= Math.max(3, Math.round(climber.prev * 0.2)) ? climber : null,
        newSource: newSource || null, newGoal: newGoal || null,
      },
    };
  }

  function build(user, sites, now, { publicUrl = '', lang = 'en' } = {}) {
    if (!Object.hasOwn(TXT, lang)) lang = 'en'; // goes into <html lang> — valid no matter who calls
    const L = TXT[lang];
    const nf = new Intl.NumberFormat(L.locale);
    const money = new Intl.NumberFormat(L.locale, { style: 'currency', currency: 'EUR' });
    const N = (x) => nf.format(x || 0);
    const regions = (() => { try { return new Intl.DisplayNames([L.locale], { type: 'region' }); } catch { return null; } })();
    const country = (cc) => (cc === '?' ? L.unknown : (regions && /^[A-Z]{2}$/.test(cc) ? regions.of(cc) : cc));
    // own keys only: the source is visitor-controlled (referrer/utm) — 'constructor' must stay a string
    const srcName = (x) => (x === 'Direct' ? L.direct : Object.hasOwn(SOURCE_NAMES, x) ? SOURCE_NAMES[x] : x);
    const devName = (x) => ({ Desktop: L.desktop, Mobile: L.mobile, Tablet: L.tablet }[x] || L.unknown);
    const dateFmt = (iso, o) => new Date(iso + 'T12:00:00Z').toLocaleDateString(L.locale, { timeZone: 'UTC', ...o });
    const pct = (a, b) => (!b ? (a ? L.new : '±0 %') : (a >= b ? '+' : '−') + Math.abs(Math.round(((a - b) / b) * 100)) + ' %');
    const dur = (s) => (s == null ? '–' : s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}&nbsp;${L.min}` : `${s}&nbsp;${L.s}`);
    const shortPath = (p) => (p.length > 58 ? p.slice(0, 55) + '…' : p);

    const blocks = sites.map((st) => ({ st, n: siteWeek(st.id, now) })).filter((b) => b.n.cur.pv || b.n.prev.pv);
    if (!blocks.length) return null;
    const n0 = blocks[0].n;
    const range = `${dateFmt(n0.from, { day: 'numeric', month: 'short' })} – ${dateFmt(n0.to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const sumV = blocks.reduce((s, b) => s + b.n.cur.v, 0), sumPrevV = blocks.reduce((s, b) => s + b.n.prev.v, 0);
    const sumPv = blocks.reduce((s, b) => s + b.n.cur.pv, 0), sumPrevPv = blocks.reduce((s, b) => s + b.n.prev.pv, 0);
    const name = user.username || '';

    // ── small HTML helpers ──
    // below 10 the change is shown absolute (+10) — +1000 % on 1 → 11 is noise
    const delta = (a, b, { invert = false, points = false } = {}) => {
      if (a == null || b == null) return '';
      let txt, good;
      if (points) { const d = a - b; if (!d) return `<span style="color:${C.faint}">±0 ${L.pp}</span>`; txt = (d > 0 ? '+' : '−') + Math.abs(d) + ' ' + L.pp; good = invert ? d < 0 : d > 0; }
      else { if (!b && !a) return ''; if (a === b) return `<span style="color:${C.faint}">±0</span>`; txt = b < 10 && a !== b ? (a > b ? '+' : '−') + N(Math.abs(a - b)) : pct(a, b); if (a === b) return `<span style="color:${C.faint}">${txt}</span>`; good = invert ? a < b : a > b; if (!b) good = !invert; }
      return `<span style="color:${good ? C.up : C.down};font-weight:600">${good === !invert ? '▲' : '▼'} ${esc(txt)}</span>`;
    };
    const h3 = (t) => `<tr><td style="padding:22px 0 8px;font-weight:700;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.faint}">${esc(t)}</td></tr>`;
    const kpi = (label, value, d) => `<td width="33%" valign="top" style="padding:10px 8px 10px 0">
      <div style="font-size:12px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</div>
      <div style="font-weight:700;font-size:22px;color:${C.text};margin:2px 0;white-space:nowrap">${value}</div>
      <div style="font-size:12px">${d || '&nbsp;'}</div></td>`;
    const barRows = (rows, label, { max = Math.max(1, ...rows.map((r) => r.v)), sub } = {}) => `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map((r) =>
      `<tr><td style="font-size:13px;padding:5px 8px 2px 0">${label(r)}</td><td align="right" style="font-weight:600;font-size:13px;white-space:nowrap;padding-top:5px">${N(r.v)}${sub ? ` <span style="font-weight:400">${sub(r)}</span>` : ''}</td></tr>` +
      `<tr><td colspan="2"><div style="background:${C.tealSoft};border-radius:3px;height:6px"><div style="width:${Math.max(2, Math.round((r.v / max) * 100))}%;background:${C.teal};border-radius:3px;height:6px;font-size:0;line-height:0">&nbsp;</div></div></td></tr>`).join('')}</table></td></tr>`;
    const chart = (days) => {
      const max = Math.max(1, ...days.map((d) => Math.max(d.v, d.prevV)));
      const best = days.reduce((m, d) => (d.v > m.v ? d : m), days[0]);
      const col = (d) => {
        const h = Math.max(3, Math.round((d.v / max) * 90)), hp = Math.max(2, Math.round((d.prevV / max) * 90));
        return `<td align="center" valign="bottom" style="padding:0 3px">
          <div style="font-weight:600;font-size:11px;color:${C.text};padding-bottom:3px">${N(d.v)}</div>
          <table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
            <td valign="bottom" style="padding-right:2px"><div style="width:9px;height:${hp}px;background:${C.line};border-radius:2px 2px 0 0;font-size:0;line-height:0">&nbsp;</div></td>
            <td valign="bottom"><div style="width:20px;height:${h}px;background:${d === best && d.v ? C.coral : C.teal};border-radius:3px 3px 0 0;font-size:0;line-height:0">&nbsp;</div></td>
          </tr></table>
          <div style="font-weight:600;font-size:11px;color:${C.dim};padding-top:4px">${L.weekdays[d.dow]}</div>
          <div style="font-size:10px;color:${C.faint}">${N(d.prevV)}</div></td>`;
      };
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:140px"><tr>${days.map(col).join('')}</tr></table>
        <div style="font-size:11px;color:${C.faint};padding-top:6px"><span style="display:inline-block;width:10px;height:10px;background:${C.teal};border-radius:2px;vertical-align:-1px"></span> ${esc(L.visitors)} &nbsp; <span style="display:inline-block;width:10px;height:10px;background:${C.line};border-radius:2px;vertical-align:-1px"></span> ${esc(L.vs)} ${esc(L.compared.replace(/^im Vergleich zur |^compared with /, ''))}</div>`;
    };
    const devicesBar = (rows) => {
      const total = rows.reduce((s, r) => s + r.v, 0) || 1;
      const colors = [C.teal, C.coral, '#7c6cf0', C.faint];
      const parts = rows.map((r, i) => ({ ...r, p: Math.round((r.v / total) * 100), c: colors[i % colors.length] })).filter((r) => r.p > 0);
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${parts.map((r) => `<td width="${r.p}%" style="height:10px;background:${r.c};font-size:0;line-height:0">&nbsp;</td>`).join('')}</tr></table>
        <div style="font-size:13px;color:${C.text};padding-top:8px">${parts.map((r) => `<span style="white-space:nowrap;margin-right:14px"><span style="display:inline-block;width:10px;height:10px;background:${r.c};border-radius:2px;vertical-align:-1px"></span> ${esc(devName(r.k))} <b>${r.p} %</b></span>`).join(' ')}</div>`;
    };
    const card = (inner) => `<tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:20px 22px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${inner}</table></td></tr><tr><td style="height:16px;font-size:0;line-height:0">&nbsp;</td></tr>`;

    const compactCard = ({ st, n }) => {
      const link = publicUrl ? `${publicUrl}/?site=${encodeURIComponent(st.domain)}` : '';
      return card(`<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-weight:700;font-size:16px">${esc(st.domain)}</td>
          ${link ? `<td align="right"><a href="${esc(link)}" style="font-weight:600;font-size:13px;color:${C.teal};text-decoration:none;white-space:nowrap">${esc(L.open)}&nbsp;→</a></td>` : ''}</tr></table></td></tr>
        ${n.cur.pv ? `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${kpi(L.visitors, N(n.cur.v), delta(n.cur.v, n.prev.v))}${kpi(L.pageviews, N(n.cur.pv), delta(n.cur.pv, n.prev.pv))}${kpi(L.bounce, n.cur.bounce == null ? '–' : n.cur.bounce + ' %', '')}</tr></table></td></tr>
          ${n.pages[0] ? `<tr><td style="font-size:13px;color:${C.dim}">${esc(L.pages)}: <span style="color:${C.text}">${esc(shortPath(n.pages[0].k))}</span> · ${esc(L.sources)}: <span style="color:${C.text}">${esc(srcName((n.sources[0] || {}).k || 'Direct'))}</span></td></tr>` : ''}`
          : `<tr><td style="font-size:14px;color:${C.dim};padding-top:10px">${esc(L.quiet)}</td></tr>`}`);
    };
    const siteCard = ({ st, n }) => {
      const link = publicUrl ? `${publicUrl}/?site=${encodeURIComponent(st.domain)}` : '';
      const hl = [];
      if (n.highlights.best) hl.push(`📈 <b>${esc(L.bestDay)}:</b> ${esc(dateFmt(n.highlights.best.day, { weekday: 'long', day: 'numeric', month: 'long' }))}, ${N(n.highlights.best.v)} ${esc(L.visitors)}`);
      if (n.highlights.climber) hl.push(`🚀 <b>${esc(L.climber)}:</b> ${esc(shortPath(n.highlights.climber.k))}, ${N(n.highlights.climber.prev)} → ${N(n.highlights.climber.v)} ${esc(L.visitors)}`);
      if (n.highlights.newSource) hl.push(`✨ <b>${esc(L.newSource)}:</b> ${esc(srcName(n.highlights.newSource.k))}, ${N(n.highlights.newSource.v)} ${esc(L.visitors)}`);
      if (n.highlights.newGoal) hl.push(`🎯 <b>${esc(L.newGoal)}:</b> ${esc(n.highlights.newGoal.k)} (${N(n.highlights.newGoal.c)}×)`);
      const quiet = !n.cur.pv;
      return card(`
        <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-weight:700;font-size:18px;color:${C.text}">${esc(st.domain)}</td>
          ${link ? `<td align="right"><a href="${esc(link)}" style="font-weight:600;font-size:13px;color:${C.teal};text-decoration:none;white-space:nowrap">${esc(L.open)}&nbsp;→</a></td>` : ''}
        </tr></table></td></tr>
        ${quiet ? `<tr><td style="font-size:14px;color:${C.dim};padding-top:10px">${esc(L.quiet)}</td></tr>` : `
        <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>${kpi(L.visitors, N(n.cur.v), delta(n.cur.v, n.prev.v))}${kpi(L.pageviews, N(n.cur.pv), delta(n.cur.pv, n.prev.pv))}${kpi(L.vpv, n.cur.vpv == null ? '–' : nf.format(n.cur.vpv), delta(n.cur.vpv, n.prev.vpv))}</tr>
          <tr>${kpi(L.bounce, n.cur.bounce == null ? '–' : n.cur.bounce + ' %', n.prev.v ? delta(n.cur.bounce, n.prev.bounce, { invert: true, points: true }) : '')}${kpi(L.time, dur(n.cur.dur), n.cur.dur != null && n.prev.dur ? delta(n.cur.dur, n.prev.dur) : '')}<td></td></tr>
        </table></td></tr>
        ${h3(L.days)}<tr><td>${chart(n.days)}</td></tr>
        ${hl.length ? h3(L.highlights) + `<tr><td style="font-size:14px;line-height:1.7;color:${C.text}">${hl.join('<br>')}</td></tr>` : ''}
        ${n.shop ? h3(L.shop) + `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            ${kpi(L.revenue, esc(money.format(n.shop.revenue)), n.shop.prevOrders >= 5 ? delta(n.shop.revenue, n.shop.prevRevenue) : '')}
            ${kpi(L.orders, N(n.shop.orders), n.shop.prevOrders >= 5 ? delta(n.shop.orders, n.shop.prevOrders) : '')}
            ${kpi(L.cr, nf.format(n.shop.cr) + ' %', '')}</tr>
            <tr>${kpi(L.aov, esc(money.format(n.shop.orders ? n.shop.revenue / n.shop.orders : 0)), '')}<td></td><td></td></tr></table></td></tr>` : ''}
        ${n.pages.length ? h3(L.pages) + barRows(n.pages, (r) => `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px">${esc(shortPath(r.k))}</span>`, { sub: (r) => delta(r.v, r.prev) }) : ''}
        ${n.sources.length ? h3(L.sources) + barRows(n.sources, (r) => esc(srcName(r.k)), { sub: (r) => delta(r.v, r.prev) }) : ''}
        ${n.countries.length ? h3(L.countries) + barRows(n.countries, (r) => `${r.k === '?' ? '🌐' : flag(r.k)} ${esc(country(r.k))}`) : ''}
        ${n.devices.length ? h3(L.devices) + `<tr><td>${devicesBar(n.devices)}</td></tr>` : ''}
        ${n.goals.length ? h3(L.goals) + n.goals.map((g) => `<tr><td style="padding:3px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:13px;color:${C.text}">🎯 ${esc(g.k)}</td>
            <td align="right" style="font-weight:600;font-size:13px;color:${C.text};white-space:nowrap">${N(g.c)}× <span style="font-weight:400">${delta(g.c, g.prev)}</span></td></tr></table></td></tr>`).join('') : ''}
        ${n.notes.length ? h3(L.notes) + `<tr><td style="font-size:13px;line-height:1.7;color:${C.text}">${n.notes.map((x) => `📌 <b>${esc(dateFmt(x.day, { weekday: 'short', day: 'numeric', month: 'numeric' }))}</b> ${esc(x.text)}`).join('<br>')}</td></tr>` : ''}
        `}`);
    };

    const trendWord = sumV > sumPrevV ? L.more : sumV < sumPrevV ? L.fewer : L.same;
    const trendPct = sumPrevV ? Math.abs(Math.round(((sumV - sumPrevV) / sumPrevV) * 100)) : null;
    const summary = blocks.length > 1 ? card(`
      <tr><td style="font-weight:700;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};padding-bottom:4px">${esc(L.allSites)}</td></tr>
      <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${kpi(L.visitors, N(sumV), delta(sumV, sumPrevV))}${kpi(L.pageviews, N(sumPv), delta(sumPv, sumPrevPv))}${kpi(L.sitesN, N(blocks.length), '')}</tr></table></td></tr>
      ${barRows(blocks.map((b) => ({ k: b.st.domain, v: b.n.cur.v, prev: b.n.prev.v })).sort((x, y) => y.v - x.v), (r) => esc(r.k), { sub: (r) => delta(r.v, r.prev) })}`) : '';
    // Gmail clips mails above ~102 KB ("[Message clipped]") — then the end, with the opt-out,
    // is hidden. Keep the HTML under a budget: the smallest sites switch to a compact card first.
    const BUDGET = 80000;
    const full = blocks.map(siteCard), small = blocks.map(compactCard);
    const cards = full.slice();
    const order = blocks.map((b, i) => i).sort((i, j) => blocks[i].n.cur.v - blocks[j].n.cur.v);
    let size = cards.reduce((t, c) => t + Buffer.byteLength(c), 0), compacted = 0;
    for (const i of order) {
      if (size <= BUDGET - 8000) break;
      size += Buffer.byteLength(small[i]) - Buffer.byteLength(cards[i]); cards[i] = small[i]; compacted++;
    }
    const preheader = `${N(sumV)} ${L.visitors} · ${pct(sumV, sumPrevV)} · ${range}`;
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>Tacilytics · ${esc(L.weekly)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};color:${C.text}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};font-family:${FONT}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:${FONT}">
  <tr><td style="padding:0 4px 18px">
    <div style="font-weight:800;font-size:22px;color:${C.text};letter-spacing:-.01em">Tacilytics<span style="color:${C.coral}">.</span></div>
    <div style="font-size:13px;color:${C.dim};padding-top:2px">${esc(L.weekly)} · ${esc(range)} · ${esc(L.compared)}</div>
  </td></tr>
  <tr><td style="padding:0 4px 18px;font-size:15px;line-height:1.6;color:${C.text}">${esc(L.hi)}${name ? ' ' + esc(name) : ''}, ${esc(L.intro)}<br>
    <b>${N(sumV)} ${esc(L.visitors)}</b>${trendPct != null && sumV !== sumPrevV ? `, ${trendPct} % ${esc(trendWord)}` : sumPrevV ? `, ${esc(trendWord)}` : ''}.</td></tr>
  ${summary}
  ${cards.join('')}
  ${compacted ? `<tr><td style="padding:0 4px 12px;font-size:12px;color:${C.faint}">${esc(L.compactNote)}</td></tr>` : ''}
  <tr><td style="padding:6px 4px 0;font-size:12px;line-height:1.6;color:${C.faint}">${esc(L.footer)}<br>${esc(L.off)}</td></tr>
</table></td></tr></table></body></html>`;

    // plain-text part: the same content, readable in any client
    const T = [];
    T.push(`Tacilytics · ${L.weekly} · ${range}`, `${L.hi}${name ? ' ' + name : ''}, ${L.intro}`, '');
    for (const { st, n } of blocks) {
      T.push(`━━ ${st.domain} ━━`);
      if (!n.cur.pv) { T.push(L.quiet, ''); continue; }
      T.push(`  ${L.visitors.padEnd(20)} ${N(n.cur.v)} (${pct(n.cur.v, n.prev.v)})`);
      T.push(`  ${L.pageviews.padEnd(20)} ${N(n.cur.pv)} (${pct(n.cur.pv, n.prev.pv)})`);
      T.push(`  ${L.bounce.padEnd(20)} ${n.cur.bounce == null ? '–' : n.cur.bounce + ' %'}`);
      T.push(`  ${L.time.padEnd(20)} ${dur(n.cur.dur).replace('&nbsp;', ' ')}`);
      T.push(`  ${L.days}: ` + n.days.map((d) => `${L.weekdays[d.dow]} ${N(d.v)}`).join(' · '));
      if (n.shop) T.push(`  ${L.revenue} ${money.format(n.shop.revenue)} · ${L.orders} ${N(n.shop.orders)} · ${L.cr} ${nf.format(n.shop.cr)} %`);
      if (n.pages.length) T.push(`  ${L.pages}: ` + n.pages.map((x) => `${shortPath(x.k)} (${N(x.v)})`).join(', '));
      if (n.sources.length) T.push(`  ${L.sources}: ` + n.sources.map((x) => `${srcName(x.k)} (${N(x.v)})`).join(', '));
      if (n.countries.length) T.push(`  ${L.countries}: ` + n.countries.map((x) => `${country(x.k)} (${N(x.v)})`).join(', '));
      if (n.goals.length) T.push(`  ${L.goals}: ` + n.goals.map((x) => `${x.k} (${N(x.c)})`).join(', '));
      if (n.notes.length) T.push(`  ${L.notes}: ` + n.notes.map((x) => `${x.day} ${x.text}`).join(' · '));
      if (publicUrl) T.push(`  ${publicUrl}/?site=${encodeURIComponent(st.domain)}`);
      T.push('');
    }
    T.push(L.off);
    const pctAll = pct(sumV, sumPrevV);
    const subject = (blocks.length === 1 ? L.subjOne(blocks[0].st.domain, N(sumV), pctAll) : L.subjMany(blocks.length, N(sumV), pctAll)).slice(0, 180);
    return { subject, text: T.join('\n') + '\n', html: html.replace(/\n\s+/g, '\n') };
  }

  return { build, siteWeek };
}

module.exports = { createReport, REPORT_LANGS: Object.keys(TXT) };
