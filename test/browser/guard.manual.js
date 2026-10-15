// Manual browser check (needs playwright + a running instance): TACI_URL=http://127.0.0.1:3998 TACI_USER=… TACI_PW=… node test/browser/guard.manual.js
// Fabian, variant C: form modals ask before Esc / backdrop throws typed input away; X and Cancel close directly.
const { chromium } = require('playwright');
(async () => {
  const U = process.env.TACI_URL; const b = await chromium.launch(); let bad = 0;
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, locale: process.env.TACI_LOCALE || 'en-US' });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  let asked = []; let answer = false;
  p.on('dialog', async (d) => { asked.push(d.message()); if (process.env.TACI_EXPECT && d.message() !== process.env.TACI_EXPECT) bad++; if (answer) await d.accept(); else await d.dismiss(); });
  const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m + (c ? '' : ' [asked=' + JSON.stringify(asked) + ']')); if (!c) bad++; };
  const open = (id) => p.evaluate((i) => !document.getElementById(i).classList.contains('hide'), id);
  const backdrop = async () => { await p.mouse.click(8, 8); await p.waitForTimeout(250); };
  await p.goto(U + '/'); await p.waitForTimeout(800);
  await p.fill('#user', process.env.TACI_USER).catch(() => {}); await p.fill('#pw', process.env.TACI_PW); await p.click('#loginBtn'); await p.waitForTimeout(3500);
  const cases = [
    ['addModal', '#addSiteBtn', async () => p.fill('#newDomain', 'typed.example')],
    ['funnelModal', '#addFunnelBtn', async () => p.fill('#funnelName', 'Signup')],
    ['annModal', '#annBtn', async () => p.fill('#annText', 'Newsletter')],
    ['alertsModal', '#alertsBtn', async () => p.fill('#alWebhook', 'https://hooks.example/x')],
  ];
  for (const [id, btn, type] of cases) {
    for (const how of ['esc', 'backdrop']) {
      const close = how === 'esc' ? async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(250); } : backdrop;
      await p.click(btn); await p.waitForTimeout(700); asked = [];
      await close(); ok(!(await open(id)) && asked.length === 0, `${id} ${how}: empty → closes without asking`);
      await p.click(btn); await p.waitForTimeout(700); await type(); asked = []; answer = false;
      await close(); ok((await open(id)) && asked.length === 1, `${id} ${how}: typed + cancel → asked once, stays open`);
      ok(await p.evaluate((i) => [].some.call(document.querySelectorAll('#' + i + ' input'), (f) => f.value && !/^\d{4}-/.test(f.value) && f.type !== 'number'), id), `${id} ${how}: input still there`);
      answer = true; asked = [];
      await close(); ok(!(await open(id)) && asked.length === 1, `${id} ${how}: typed + OK → closes`);
    }
    // X: deliberate, no question
    await p.click(btn); await p.waitForTimeout(700); await type(); asked = [];
    await p.click('#' + id + ' .modal-x'); await p.waitForTimeout(250);
    ok(!(await open(id)) && asked.length === 0, `${id} X: typed → closes without asking`);
    // typed and deleted again = no change
    await p.click(btn); await p.waitForTimeout(700); await type();
    await p.evaluate((i) => { const f = [].filter.call(document.querySelectorAll('#' + i + ' input[type=text], #' + i + ' input[type=url]'), (x) => x.value)[0]; if (f) { f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); } }, id);
    if (id === 'annModal') await p.evaluate(() => {}); asked = [];
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    ok(!(await open(id)) && asked.length === 0, `${id}: typed + deleted again → no question`);
  }
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  console.log(bad ? `${bad} FAILED` : 'all green'); await b.close(); process.exit(bad ? 1 : 0);
})();
