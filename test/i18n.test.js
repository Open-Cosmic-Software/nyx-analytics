'use strict';
// Dictionary sanity for public/i18n.js — runs without a browser.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');
const start = src.indexOf('var DE = {') + 'var DE = '.length;
const DE = new Function('return ' + src.slice(start, src.indexOf('\n  };', start) + 4))();

test('i18n: no chains — a German value is never itself a key with another value', () => {
  // with a chain the MutationObserver would translate its own output again (and again)
  const bad = Object.keys(DE).filter((k) => Object.prototype.hasOwnProperty.call(DE, DE[k]) && DE[DE[k]] !== DE[k]);
  assert.deepStrictEqual(bad, []);
});
test('i18n: every UI text in index.html has a German entry', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  const texts = new Set();
  for (const m of body.matchAll(/>([^<>]+)</g)) { const t = m[1].trim().replace(/&amp;/g, '&'); if (t && /[A-Za-z]{2}/.test(t)) texts.add(t); }
  for (const m of body.matchAll(/(?:placeholder|title)="([^"]+)"/g)) texts.add(m[1].replace(/&amp;/g, '&'));
  const keep = new Set(['Tacilytics', 'GitHub', 'CSV', 'OS', 'Plausible', 'Google Analytics 4', 'Live', 'Top', 'Medium', 'Funnels', 'Team', 'Import', 'example.com', 'Webhook URL (https://…)', 'Website']);
  const missing = [...texts].filter((t) => !keep.has(t) && !Object.prototype.hasOwnProperty.call(DE, t));
  assert.deepStrictEqual(missing, []);
});
test('i18n: the attribute writer never writes an unchanged value (that would loop the observer)', () => {
  assert.match(src, /if \(tv != null && tv !== v\) node\.setAttribute/);
  assert.match(src, /if \(t != null && t !== node\.nodeValue\) node\.nodeValue = t/);
});

// ── modals (2.2.0, Fabian: "no X anywhere") ──
test('modals: every closable modal has an X, login/reset/invite have none', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/<div id="([A-Za-z]+)" class="modal-overlay/g)].map((m) => m[1]);
  const block = (id) => { const i = html.indexOf(`<div id="${id}" class="modal-overlay`); const j = html.indexOf('class="modal-overlay', html.indexOf('>', i)); return html.slice(i, j < 0 ? undefined : j); };
  for (const id of ids) {
    const hasX = /class="modal-x" data-close aria-label="Close"/.test(block(id));
    assert.strictEqual(hasX, !['login', 'reset', 'invite'].includes(id), id);
  }
  assert.ok(ids.length >= 12, 'found ' + ids.length + ' modals');
});
test('modals: one close path — no handler hides a modal overlay directly', () => {
  for (const f of ['app.js', 'account.js']) {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    // closing = closeModal(); only "after success" spots may still hide (site created, funnel created,
    // share revoked) — they are not user exits
    const direct = [...js.matchAll(/\$\('(\w+Modal)'\)\.classList\.add\('hide'\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(direct.filter((id) => !['addModal', 'funnelModal', 'shareModal'].includes(id)), [], f);
    assert.ok(!/(close|cancel)\w*'\)\.onclick = function \(\) \{ \$\('\w+'\)\.classList\.add\('hide'\)/.test(js), f + ': a close button bypasses closeModal');
  }
  const acc = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.js'), 'utf8');
  assert.match(acc, /var LOCKED = \{ login: 1, reset: 1, invite: 1 \}/);
  assert.match(acc, /e\.key !== 'Escape'/);
});
test('i18n: the OTP hint is a whole sentence in the dictionary (no inline <strong> splitting it)', () => {
  const acc = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.js'), 'utf8');
  const s = 'Signing in with your password also asks for a 6-digit code from your authenticator app.';
  assert.ok(acc.includes('>' + s + '</p>'), 'sentence must be its own text node');
  assert.ok(Object.prototype.hasOwnProperty.call(DE, s));
  assert.ok(Object.prototype.hasOwnProperty.call(DE, 'Recovery codes left:'));
});
