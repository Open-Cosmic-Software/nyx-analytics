'use strict';
// Variant C (Fabian): filled form modals ask before Esc/backdrop throw input away.
// Source checks for the paths that must NOT ask; the browser check (test/browser/guard.manual.js) drives them for real.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('showLogin() closes open modals with force — an expired session never asks (Tyto, Kiro)', () => {
  const m = app.match(/function showLogin\(\) \{[^\n]*/);
  assert.ok(m, 'showLogin() found');
  assert.match(m[0], /closeModal\(o, \{ force: true \}\)/, 'showLogin passes force');
  assert.doesNotMatch(m[0], /closeModal\(o\)/, 'no closeModal without force in showLogin');
});

test('X and Cancel close with force, Esc and backdrop go through the guard', () => {
  for (const [btn, modal] of [['cancelAdd', 'addModal'], ['closeAlerts', 'alertsModal'], ['closeAnn', 'annModal'], ['cancelFunnel', 'funnelModal']]) {
    assert.ok(app.includes(`$('${btn}').onclick = function () { closeModal($('${modal}'), { force: true }); };`), `${btn} forces`);
  }
});
