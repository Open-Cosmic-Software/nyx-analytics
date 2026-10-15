// Manual browser check: TACI_URL=… TACI_USER=… TACI_PW=… node test/browser/hitkey.manual.js
// Settings → API keys: create a "server mode (count only)" key for one site, list shows it, it can only report.
const { chromium } = require('playwright');
(async () => {
  const U = process.env.TACI_URL; const b = await chromium.launch(); let bad = 0;
  const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) bad++; };
  for (const locale of ['en-US', 'de-DE']) {
    const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, locale });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(U + '/'); await p.waitForTimeout(800);
    await p.fill('#user', process.env.TACI_USER).catch(() => {}); await p.fill('#pw', process.env.TACI_PW); await p.click('#loginBtn'); await p.waitForTimeout(2500);
    await p.evaluate(() => window.openSettings ? window.openSettings('security') : document.getElementById('settingsBtn').click()); await p.waitForTimeout(800);
    if (!(await p.$('#keyKind'))) { await p.click('[data-tab="security"]').catch(() => {}); await p.waitForTimeout(800); }
    ok(!!(await p.$('#keyKind')), `${locale}: key kind select exists`);
    await p.selectOption('#keyKind', 'hit'); await p.waitForTimeout(200);
    const boxes = await p.$$('.keySite');
    ok(boxes.length >= 1 && !(await p.evaluate(() => document.getElementById('keySites').classList.contains('hide'))), `${locale}: site checkboxes shown (${boxes.length})`);
    await boxes[0].check(); await p.fill('#keyName', 'web ' + locale); await p.click('#keyAdd'); await p.waitForTimeout(1200);
    const key = (await p.textContent('#keyOut .snippet').catch(() => '')).trim();
    ok(/^tk_/.test(key), `${locale}: key shown once`);
    const pill = await p.textContent('#keyList');
    ok(locale === 'de-DE' ? /Server-Modus/.test(pill) && !/server mode/i.test(pill.replace(/Server-Modus/g, '')) : /server mode/.test(pill), `${locale}: list labels it as server mode`);
    const r1 = await p.evaluate((k) => fetch('/api/v1/sites', { headers: { Authorization: 'Bearer ' + k } }).then((r) => r.status), key);
    ok(r1 === 403, `${locale}: the new key cannot read (${r1})`);
    if (locale === 'de-DE') ok(/Leg nie einen Key mit Schreibrechten/.test(await p.textContent('#settingsModal')), 'de: hint translated');
    ok(errs.length === 0, `${locale}: no page errors ${JSON.stringify(errs)}`);
    await p.screenshot({ path: '/tmp/taci-ui/hitkey-' + locale + '.png', fullPage: false });
    await ctx.close();
  }
  console.log(bad ? `${bad} FAILED` : 'all green'); await b.close(); process.exit(bad ? 1 : 0);
})();
