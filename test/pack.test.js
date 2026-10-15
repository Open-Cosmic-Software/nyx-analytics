'use strict';
// The npm tarball must contain every local file the packaged code requires. 2.2.0 nearly shipped
// without tz.js (report.js/server.js require('./tz')) because package.json "files" is an allowlist.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
test('npm pack contains every locally required file', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  const files = new Set(JSON.parse(out)[0].files.map(f => f.path));
  const missing = [];
  for (const f of files) {
    if (!/\.js$/.test(f) || f.startsWith('public/') || f.startsWith('sdk/')) continue;
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let p = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (!/\.(js|json)$/.test(p)) p += '.js';
      if (!files.has(p)) missing.push(f + ' → ' + p);
    }
  }
  assert.ok(files.has('server.js') && files.has('report.js'), 'sanity: tarball listed');
  assert.deepStrictEqual(missing, []);
});
