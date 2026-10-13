'use strict';
// npm test  (node --test test/*.test.js)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDaySalt } = require('../day-salt.js');

const T = Date.parse('2026-10-13T12:00:00Z');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daysalt-')), '.day-salt');
const write = (f, s) => { const b = Buffer.alloc(128, 0); b.write(s); fs.writeFileSync(f, b); };

test('today + truncated salt (crash between open and fsync) is repaired, not null until midnight', () => {
  const f = tmp();
  write(f, '2026-10-13 abc');
  const s1 = createDaySalt(f, () => T)();
  assert.match(s1 || '', /^[0-9a-f]{64}$/, 'must draw a new salt instead of returning null');
  // a second process start reads the repaired file and gets the same salt → same visitor hash
  const s2 = createDaySalt(f, () => T)();
  assert.strictEqual(s2, s1);
  assert.ok(fs.readFileSync(f, 'utf8').startsWith(`2026-10-13 ${s1}`));
});

test('today + empty salt field is repaired', () => {
  const f = tmp(); write(f, '2026-10-13');
  assert.match(createDaySalt(f, () => T)() || '', /^[0-9a-f]{64}$/);
});

test('valid salt for today is kept (restart does not split visitors)', () => {
  const f = tmp(); const good = 'a'.repeat(64); write(f, `2026-10-13 ${good}`);
  assert.strictEqual(createDaySalt(f, () => T)(), good);
});

test('older day is overwritten in place with a new salt, file stays 128 bytes and 0600', () => {
  const f = tmp(); const old = 'b'.repeat(64); write(f, `2026-10-12 ${old}`);
  const s = createDaySalt(f, () => T)();
  assert.notStrictEqual(s, old);
  const raw = fs.readFileSync(f);
  assert.strictEqual(raw.length, 128);
  assert.ok(!raw.toString().includes(old), 'old salt bytes must be gone from the file');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});

test('file from a later day (clock went backwards) is left alone → null', () => {
  const f = tmp(); const newer = 'c'.repeat(64); write(f, `2026-10-14 ${newer}`);
  assert.strictEqual(createDaySalt(f, () => T)(), null);
  assert.ok(fs.readFileSync(f, 'utf8').startsWith(`2026-10-14 ${newer}`), 'newer salt untouched');
});

test('missing file → new salt', () => {
  const f = tmp();
  assert.match(createDaySalt(f, () => T)() || '', /^[0-9a-f]{64}$/);
});
