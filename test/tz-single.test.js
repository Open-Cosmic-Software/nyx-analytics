'use strict';
// Tyto 6: weekly report, digest and alerts take their day/hour boundaries from tz.js only — no second
// calculation (no 24 h steps, no UTC getters) that could drift from the dashboard on DST days.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function body(code, sig) {
  const i = code.indexOf(sig); assert.ok(i >= 0, sig + ' found');
  let depth = 0, j = code.indexOf('{', i);
  for (let k = j; k < code.length; k++) { if (code[k] === '{') depth++; else if (code[k] === '}' && --depth === 0) return code.slice(j, k + 1); }
}
const BAD = /864e5|86400000|24\s*\*\s*36|getUTC(Date|Day|Hours)|setUTC|toISOString\(\)\.slice\(0,\s*10\)/;
test('weekly report, digest and alerts use tz.js only (Tyto 6)', () => {
  const server = src('server.js'), report = src('report.js');
  for (const [name, b] of [['report siteWeek', body(report, 'function siteWeek(')], ['digestBody', body(server, 'function digestBody(')], ['trafficVerdict', body(server, 'function trafficVerdict(')]]) {
    assert.doesNotMatch(b, BAD, name + ' computes its own boundaries');
    assert.match(b, /TZ\.(dayStart|localDay|sameLocalTime|daySql)/, name + ' goes through tz.js');
  }
});
