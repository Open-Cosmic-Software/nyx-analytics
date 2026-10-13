'use strict';
// Daily salt (13.10.2026, hardened after two reviews by Tyto 🦉): a fresh random secret per
// UTC day, kept in its own small file, never in the database. See README "Privacy & security".
//
// Rules:
// - Only the server clock decides the day. A salt is only ever created for *today*.
// - A file with today's date but an invalid salt (e.g. truncated by a crash) is repaired by
//   drawing a new salt. Otherwise every visitor would get a one-off hash until midnight.
// - Only a file from a *later* day than our clock (clock went backwards) is left alone: then
//   we return null and the caller uses an unlinkable one-off hash.
// - Single process only. nyx-analytics runs one Node process (one app.listen, no cluster).
//   With several processes, each would draw its own salt at midnight and the last writer
//   would win; that would need an O_EXCL create + re-read instead.
const fs = require('fs');
const crypto = require('crypto');

const SIZE = 128; // fixed size → the old value is fully overwritten in place
const VALID = /^[0-9a-f]{64}$/;

function dayStr(ts) { return new Date(ts).toISOString().slice(0, 10); }

function createDaySalt(file, now = Date.now) {
  let cache = { day: null, salt: null };

  function writeInPlace(content) {
    const buf = Buffer.alloc(SIZE, 0); buf.write(content);
    const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w', 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, buf, 0, buf.length, 0); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }

  function read() {
    try { return fs.readFileSync(file, 'utf8').replace(/\0+$/, '').split(' '); } catch { return null; }
  }

  return function todaysSalt() {
    const today = dayStr(now());
    if (cache.day === today) return cache.salt;
    const stored = read();
    const storedDay = stored && stored[0];
    if (storedDay === today && VALID.test(stored[1] || '')) {
      cache = { day: today, salt: stored[1] };
    } else if (!storedDay || storedDay <= today) {
      // missing, older day, or today's date with a broken salt → draw a new one
      const salt = crypto.randomBytes(32).toString('hex');
      writeInPlace(`${today} ${salt}`);
      cache = { day: today, salt };
    } else {
      return null; // file is from a later day than our clock: never overwrite a newer salt
    }
    return cache.salt;
  };
}

module.exports = { createDaySalt, dayStr };
