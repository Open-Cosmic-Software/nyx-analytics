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
