// Manual browser check (needs playwright, not part of npm test): node test/browser/downloads.manual.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const tracker = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'tacilytics.js'), 'utf8');
  const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
  const ev = [];
  await ctx.route('https://an.test/tacilytics.js', (r) => r.fulfill({ body: tracker, contentType: 'application/javascript' }));
  await ctx.route('https://an.test/api/collect', (r) => { const j = JSON.parse(r.request().postData() || '{}'); if (j.n) ev.push(j); r.fulfill({ status: 204 }); });
  const page = (attrs) => `<html><body><script defer data-domain="shop.test" ${attrs} src="https://an.test/tacilytics.js"></script>
    <a id="pdf" href="/files/Katalog%202026.pdf?token=secret">pdf</a>
    <a id="zipx" href="https://cdn.other.test/dl/app.zip">zip ext</a>
    <a id="dlattr" href="/export?id=7" download>attr</a>
    <a id="html" href="/about.html">html</a>
    <a id="out" href="https://other.test/page">out</a></body></html>`;
  const run = async (attrs) => {
    await ctx.route('https://shop.test/**', (r) => r.fulfill({ contentType: 'text/html', body: page(attrs) }));
    ev.length = 0;
    await p.goto('https://shop.test/'); await p.waitForTimeout(400);
    // block real navigation so every click is measured on the same page
    await p.evaluate(() => document.addEventListener('click', (e) => e.preventDefault()));
    for (const id of ['pdf', 'zipx', 'dlattr', 'html', 'out']) await p.click('#' + id);
    await p.waitForTimeout(400);
    await ctx.unroute('https://shop.test/**');
    return ev.map((e) => e.n + ':' + (e.pr && (e.pr.file || e.pr.url)));
  };
  const both = await run('data-track-downloads data-track-outbound');
  const custom = await run('data-track-downloads="zip"');
  const none = await run('');
  console.log(JSON.stringify({ both, custom, none }, null, 1));
  const want = {
    both: ['File Download:Katalog 2026.pdf', 'File Download:app.zip', 'File Download:export', 'Outbound Link:other.test/page'],
    custom: ['File Download:app.zip', 'File Download:export'],
    none: [],
  };
  const bad = Object.keys(want).filter((k) => JSON.stringify(want[k]) !== JSON.stringify({ both, custom, none }[k]));
  const leaked = JSON.stringify(both).includes('secret');
  if (bad.length || leaked) { console.error('FAIL', bad.join(', '), leaked ? 'query leaked' : ''); process.exitCode = 1; } else console.log('ok');
  await b.close();
})();
