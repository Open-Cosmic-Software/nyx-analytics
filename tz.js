'use strict';
// Per-site time zones (Fabian, 2.2/2.3). Stored data stays UTC (events.day, salts, imports — Tyto a);
// only the boundaries of "a day" in a query move. Offsets are taken per instant from Intl in MINUTES —
// never rounded to hours (Kiro d: +5:30, +5:45, Lord Howe's 30-min DST) — and every local day gets its
// own boundaries, so DST days are 23 or 25 hours long instead of 24 (Tyto c).
const DAY = 864e5;
const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}
// Only IANA names Intl knows (Kiro e). Returns the name as given (ICU's resolvedOptions would turn
// Asia/Kathmandu into the legacy Asia/Katmandu) or null.
function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return null; }
}
function parts(tz, ms) {
  const p = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}
// minutes east of UTC at instant ms
function offsetMin(tz, ms) {
  if (!tz || tz === 'UTC') return 0;
  const p = parts(tz, ms);
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000);
}
// local calendar day (YYYY-MM-DD) of instant ms
function localDay(tz, ms) {
  if (!tz || tz === 'UTC') return new Date(ms).toISOString().slice(0, 10);
  return new Date(ms + offsetMin(tz, ms) * 60000).toISOString().slice(0, 10);
}
// UTC instant of local midnight that starts day (YYYY-MM-DD). Two passes settle the offset in force
// at that midnight even when the day before had a different one.
function dayStart(tz, day) {
  const wall = Date.parse(day + 'T00:00:00Z');
  if (!tz || tz === 'UTC') return wall;
  let t = wall - offsetMin(tz, wall) * 60000;
  t = wall - offsetMin(tz, t) * 60000;
  return t;
}
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10); }
// local days from..to (inclusive) with their UTC [start, end)
function days(tz, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ day: d, start: dayStart(tz, d), end: dayStart(tz, addDays(d, 1)) });
  return out;
}
// ISO weekday of a local day (0 = Sunday, like getUTCDay)
function weekday(day) { return new Date(day + 'T12:00:00Z').getUTCDay(); }
// Offset segments covering [start, end): [{ from, to, off }] with off in minutes. Transitions are found
// day by day and pinned to the minute by bisection, so a DST switch (or Lord Howe's 30-min one) lands
// exactly where Intl says.
function segments(tz, start, end) {
  if (!tz || tz === 'UTC') return [{ from: start, to: end, off: 0 }];
  const out = [];
  let from = start, off = offsetMin(tz, start);
  for (let t = start; t < end;) {
    const next = Math.min(end, t + 6 * 36e5);
    const o2 = offsetMin(tz, next === end ? end - 1 : next);
    if (o2 !== off) {
      let lo = t, hi = next === end ? end - 1 : next;
      while (hi - lo > 60000) { const mid = Math.floor((lo + hi) / 2 / 60000) * 60000; if (offsetMin(tz, mid) === off) lo = mid; else hi = mid; }
      out.push({ from, to: hi, off }); from = hi; off = o2;
    }
    t = next;
  }
  out.push({ from, to: end, off });
  return out;
}
// SQL expression: ts shifted to local wall-clock ms. Only integers from segments() are inlined.
function shiftSql(tz, start, end, col = 'ts') {
  const seg = segments(tz, start, end).filter((s) => s.to > s.from);
  const ms = (s) => String(Math.trunc(s.off) * 60000);
  if (seg.length === 1) return `(${col} + ${ms(seg[0])})`;
  let sql = '(' + col + ' + CASE';
  for (let i = 0; i < seg.length - 1; i++) sql += ` WHEN ${col} < ${Math.trunc(seg[i].to)} THEN ${ms(seg[i])}`;
  return sql + ` ELSE ${ms(seg[seg.length - 1])} END)`;
}
// SQL: local day 'YYYY-MM-DD' of ts
function daySql(tz, start, end, col = 'ts') { return `date(${shiftSql(tz, start, end, col)} / 1000, 'unixepoch')`; }
// same local wall-clock time d days earlier (= t - d×24h unless a DST switch lies between) — the alert
// baseline compares "this hour" with the same LOCAL hour of earlier days
function sameLocalTime(tz, t, d) {
  const back = t - d * DAY;
  return back + (offsetMin(tz, t) - offsetMin(tz, back)) * 60000;
}
module.exports = { sameLocalTime, segments, shiftSql, daySql, validTz, offsetMin, localDay, dayStart, addDays, days, weekday, DAY };
