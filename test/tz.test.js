'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tz = require('../tz');
const U = (s) => Date.parse(s);

test('validTz: IANA names only (Kiro e)', () => {
  assert.strictEqual(tz.validTz('Europe/Berlin'), 'Europe/Berlin');
  assert.strictEqual(tz.validTz('UTC'), 'UTC');
  assert.strictEqual(tz.validTz('Asia/Kathmandu'), 'Asia/Kathmandu');
  for (const bad of ['Mars/Base', '', null, 42, 'Europe/Berlin; DROP', '../etc', 'x'.repeat(80)]) assert.strictEqual(tz.validTz(bad), null, String(bad));
});

test('Berlin: 23:30 UTC belongs to the next local day', () => {
  assert.strictEqual(tz.localDay('Europe/Berlin', U('2026-10-14T23:30:00Z')), '2026-10-15');
  assert.strictEqual(tz.localDay('UTC', U('2026-10-14T23:30:00Z')), '2026-10-14');
});

test('DST end 25.10.2026: Berlin day is 25 h, boundaries from Intl (Tyto c)', () => {
  const d = tz.days('Europe/Berlin', '2026-10-24', '2026-10-26');
  assert.deepStrictEqual(d.map((x) => (x.end - x.start) / 36e5), [24, 25, 24]);
  assert.strictEqual(new Date(d[1].start).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.strictEqual(new Date(d[2].start).toISOString(), '2026-10-25T23:00:00.000Z');
  // DST start 29.03.2026: 23 h
  const s = tz.days('Europe/Berlin', '2026-03-29', '2026-03-29')[0];
  assert.strictEqual((s.end - s.start) / 36e5, 23);
});

test('non-whole-hour offsets stay in minutes (Kiro d)', () => {
  assert.strictEqual(tz.offsetMin('Asia/Kathmandu', U('2026-10-25T12:00:00Z')), 345);
  assert.strictEqual(tz.offsetMin('Asia/Kolkata', U('2026-10-25T12:00:00Z')), 330);
  const k = tz.days('Asia/Kathmandu', '2026-10-25', '2026-10-25')[0];
  assert.strictEqual(new Date(k.start).toISOString(), '2026-10-24T18:15:00.000Z');
  assert.strictEqual((k.end - k.start) / 36e5, 24);
  // Berlin and Kathmandu on the same instant, 25.10.: 18:20 UTC is 25.10. in Kathmandu (00:05), still 25.10. in Berlin
  assert.strictEqual(tz.localDay('Asia/Kathmandu', U('2026-10-24T18:20:00Z')), '2026-10-25');
  assert.strictEqual(tz.localDay('Europe/Berlin', U('2026-10-24T18:20:00Z')), '2026-10-24');
  // Lord Howe: half-hour DST (+10:30 → +11 on 04.10.2026)
  assert.strictEqual(tz.offsetMin('Australia/Lord_Howe', U('2026-09-20T12:00:00Z')), 630);
  assert.strictEqual(tz.offsetMin('Australia/Lord_Howe', U('2026-10-20T12:00:00Z')), 660);
});

test('every instant falls in exactly one local day', () => {
  for (const z of ['Europe/Berlin', 'Asia/Kathmandu', 'America/St_Johns', 'Australia/Lord_Howe', 'UTC']) {
    const d = tz.days(z, '2026-03-25', '2026-11-05');
    for (let i = 1; i < d.length; i++) assert.strictEqual(d[i].start, d[i - 1].end, z + ' ' + d[i].day);
    for (let t = d[0].start; t < d[d.length - 1].end; t += 7 * 60000 * 13) {
      const hit = d.filter((x) => t >= x.start && t < x.end);
      assert.strictEqual(hit.length, 1);
      assert.strictEqual(hit[0].day, tz.localDay(z, t), z + ' ' + new Date(t).toISOString());
    }
  }
});

test('segments: DST switch pinned to the minute, SQL day matches localDay', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const a = U('2026-10-20T00:00:00Z'), b = U('2026-10-30T00:00:00Z');
  const s = tz.segments('Europe/Berlin', a, b);
  assert.strictEqual(s.length, 2);
  assert.strictEqual(new Date(s[0].to).toISOString(), '2026-10-25T01:00:00.000Z');
  assert.deepStrictEqual(s.map((x) => x.off), [120, 60]);
  for (const z of ['Europe/Berlin', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'America/St_Johns', 'UTC']) {
    const from = U('2026-03-20T00:00:00Z'), to = U('2026-11-10T00:00:00Z');
    const q = db.prepare(`SELECT ${tz.daySql(z, from, to, '?')} d`);
    for (let t = from; t < to; t += 3600000 * 5 + 17 * 60000) assert.strictEqual(q.get(...Array(tz.segments(z, from, to).length).fill(t)).d, tz.localDay(z, t), z + ' ' + new Date(t).toISOString());
  }
});

test('weekly report: last 7 LOCAL days, DST week = 7 days with 167/169 h (Tyto c)', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, site_id INT, ts INT, day TEXT, path TEXT, vh TEXT, name TEXT, props TEXT, source TEXT, country TEXT, device TEXT, dur INT);
    CREATE TABLE internal_vh (site_id INT, vh TEXT, day TEXT); CREATE TABLE annotations (id INTEGER PRIMARY KEY, site_id INT, day TEXT, text TEXT);`);
  const ins = db.prepare("INSERT INTO events (site_id, ts, day, path, vh) VALUES (1, ?, ?, '/', ?)");
  // Monday 27.10.2025 06:00 UTC; Berlin week = Mon 20.10. .. Sun 26.10. (the Sunday is 25 h)
  const hit = (iso, vh) => ins.run(Date.parse(iso), iso.slice(0, 10), vh);
  hit('2025-10-19T22:30:00Z', 'a'); // Mon 20.10. 00:30 Berlin → in the week (UTC: Sunday 19.10., outside)
  hit('2025-10-26T22:30:00Z', 'b'); // Sun 26.10. 23:30 CET → in the week (25 h day)
  hit('2025-10-26T23:30:00Z', 'c'); // Mon 27.10. 00:30 CET → today, outside
  const { createReport } = require('../report');
  const R = createReport(db);
  const now = Date.parse('2025-10-27T06:00:00Z');
  const ber = R.siteWeek(1, now, 'Europe/Berlin');
  assert.deepStrictEqual([ber.from, ber.to, ber.timezone], ['2025-10-20', '2025-10-26', 'Europe/Berlin']);
  assert.deepStrictEqual(ber.days.map((d) => d.dow), [1, 2, 3, 4, 5, 6, 0]);
  assert.strictEqual(ber.cur.pv, 2);
  assert.deepStrictEqual([ber.days[0].pv, ber.days[6].pv], [1, 1]);
  const utc = R.siteWeek(1, now);
  assert.deepStrictEqual([utc.from, utc.to, utc.cur.pv], ['2025-10-20', '2025-10-26', 2]); // b + c, not a
  assert.strictEqual(R.siteWeek(1, now, 'Mars/Base').timezone, 'UTC');
});

test('alerts: baseline is the same LOCAL hour on earlier days (Tyto c)', () => {
  // Wed 29.10.2025 09:00 CET (08:00Z); 7 days back is Wed 22.10. 09:00 CEST = 07:00Z, not 08:00Z
  const t = U('2025-10-29T08:00:00Z');
  assert.strictEqual(new Date(tz.sameLocalTime('Europe/Berlin', t, 7)).toISOString(), '2025-10-22T07:00:00.000Z');
  assert.strictEqual(new Date(tz.sameLocalTime('Europe/Berlin', t, 1)).toISOString(), '2025-10-28T08:00:00.000Z');
  assert.strictEqual(new Date(tz.sameLocalTime('UTC', t, 7)).toISOString(), '2025-10-22T08:00:00.000Z');
  assert.strictEqual(new Date(tz.sameLocalTime('Asia/Kathmandu', t, 7)).toISOString(), '2025-10-22T08:00:00.000Z');
});

// Kiro's expected values (Rudel 11:13Z, measured with Node 22) — a day is [midnight(d), midnight(d+1))
test('day lengths across DST and odd offsets (Kiro)', () => {
  const H = (z, d) => (tz.dayStart(z, tz.addDays(d, 1)) - tz.dayStart(z, d)) / 36e5;
  assert.strictEqual(H('Europe/Berlin', '2026-10-25'), 25);
  assert.strictEqual(H('Europe/Berlin', '2026-10-24'), 24);
  assert.strictEqual(H('Europe/Berlin', '2027-03-28'), 23);
  assert.strictEqual(H('Australia/Lord_Howe', '2026-10-04'), 23.5);
  assert.strictEqual(H('America/St_Johns', '2026-11-01'), 25);
  assert.strictEqual(new Date(tz.dayStart('Asia/Kathmandu', '2026-10-25')).toISOString(), '2026-10-24T18:15:00.000Z');
  assert.strictEqual(tz.localDay('Europe/Berlin', U('2026-10-15T23:30:00Z')), '2026-10-16');
  assert.strictEqual(tz.validTz('Mars/Olympus'), null);
});

// Kiro's open edge: the clock jumps over midnight (Santiago 6 Sep 2026: 00:00 → 01:00), so there is no
// local 00:00. The day starts at its first instant (01:00 local), not at 23:00 of the day before.
test('a day whose midnight does not exist starts at its first local instant', () => {
  const s = tz.dayStart('America/Santiago', '2026-09-06');
  assert.strictEqual(new Date(s).toISOString(), '2026-09-06T04:00:00.000Z');
  assert.strictEqual(tz.localDay('America/Santiago', s), '2026-09-06');
  assert.strictEqual(tz.localDay('America/Santiago', s - 60000), '2026-09-05');
  assert.strictEqual((tz.dayStart('America/Santiago', '2026-09-07') - s) / 36e5, 23);
  assert.strictEqual((s - tz.dayStart('America/Santiago', '2026-09-05')) / 36e5, 24);
  // Tyto (Rudel 11:15Z): Beirut 29 Mar 2026 jumps 00:00 → 01:00 as well; the day starts 22:00Z = 01:00 local
  assert.strictEqual(new Date(tz.dayStart('Asia/Beirut', '2026-03-29')).toISOString(), '2026-03-28T22:00:00.000Z');
  // every day boundary of a year in such zones is consistent: start belongs to the day, start-1min does not
  for (const z of ['America/Santiago', 'Asia/Beirut', 'America/Havana', 'Europe/Berlin', 'Asia/Kathmandu', 'Australia/Lord_Howe']) {
    for (let d = '2026-01-01'; d <= '2027-12-31'; d = tz.addDays(d, 1)) {
      const t = tz.dayStart(z, d);
      assert.strictEqual(tz.localDay(z, t), d, z + ' ' + d);
      assert.strictEqual(tz.localDay(z, t - 60000), tz.addDays(d, -1), z + ' ' + d + ' -1min');
      assert.ok(tz.dayStart(z, tz.addDays(d, 1)) > t, z + ' ' + d + ' next day starts later');
    }
  }
});
