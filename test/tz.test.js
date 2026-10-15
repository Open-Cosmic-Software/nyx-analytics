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
