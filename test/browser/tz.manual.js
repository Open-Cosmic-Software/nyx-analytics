// Manual browser check: TACI_URL=… TACI_USER=… TACI_PW=… node test/browser/tz.manual.js
// Per-site time zone UI: default from the browser on "Add site", header button, change + reload, guard, German.
const { chromium } = require('playwright');
(async () => {
  const U = process.env.TACI_URL; const b = await chromium.launch(); let bad = 0;
  const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) bad++; };
  for (const [locale, tzId, de] of [['en-US', 'Asia/Kathmandu', false], ['de-DE', 'Europe/Berlin', true]]) {
    const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, locale, timezoneId: tzId });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const asked = []; p.on('dialog', async (d) => { asked.push(d.message()); await d.dismiss(); });
    await p.goto(U + '/'); await p.waitForTimeout(800);
    await p.fill('#user', process.env.TACI_USER).catch(() => {}); await p.fill('#pw', process.env.TACI_PW); await p.click('#loginBtn'); await p.waitForTimeout(3000);
    // Chromium/ICU report legacy aliases (Asia/Kathmandu → Asia/Katmandu); both are valid and compute the same
    const tzId2 = await p.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    const dom = 'tz-' + locale.toLowerCase() + '-' + Date.now() + '.test';
    await p.click('#addSiteBtn'); await p.waitForTimeout(400);
    ok(await p.inputValue('#newTz') === tzId2, `${locale}: Add site preselects the browser zone ${tzId2}`);
    const n = await p.evaluate(() => document.getElementById('newTz').options.length);
    ok(n > 300, `${locale}: zone list from Intl (${n})`);
    await p.fill('#newDomain', dom); await p.click('#createSiteBtn'); await p.waitForTimeout(1500);
    await p.evaluate(() => { const s = document.getElementById('snippetModal'); if (s && !s.classList.contains('hide')) window.TaciModal.close(s, { force: true }); });
    ok((await p.textContent('#tzName')).trim() === tzId2.replace(/_/g, ' '), `${locale}: header shows ${tzId2}`);
    // change → saved, reloaded
    await p.click('#tzBtn'); await p.waitForTimeout(400);
    ok(await p.inputValue('#tzSelect') === tzId2, `${locale}: modal preselects the current zone`);
    if (de) ok((await p.textContent('#tzModal h2')).trim() === 'Zeitzone', 'de: title translated');
    await p.selectOption('#tzSelect', 'America/St_Johns'); asked.length = 0;
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    ok(asked.length === 1 && asked[0] === (de ? 'Änderungen verwerfen?' : 'Discard your changes?'), `${locale}: changed zone + Esc asks (${asked[0]})`);
    await p.click('#saveTz'); await p.waitForTimeout(1500);
    ok(await p.evaluate(() => document.getElementById('tzModal').classList.contains('hide')), `${locale}: saved → modal closed`);
    ok((await p.textContent('#tzName')).trim() === 'America/St Johns', `${locale}: header follows the new zone`);
    const api = await p.evaluate((d) => fetch('/api/stats?site=' + d + '&period=7d', { headers: { 'x-session-token': localStorage.getItem('nyx_token') } }).then((r) => r.json()), dom);
    ok(api.timezone === 'America/St_Johns', `${locale}: stats run in the site zone (${api.timezone})`);
    ok(errs.length === 0, `${locale}: no page errors ${JSON.stringify(errs)}`);
    await p.screenshot({ path: '/tmp/taci-ui/tz-' + locale + '.png' });
    await p.click('#tzBtn'); await p.waitForTimeout(400); await p.screenshot({ path: '/tmp/taci-ui/tz-modal-' + locale + '.png' });
    await ctx.close();
  }
  console.log(bad ? `${bad} FAILED` : 'all green'); await b.close(); process.exit(bad ? 1 : 0);
})();
