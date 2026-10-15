// Manual browser check (needs playwright, not part of npm test): node test/browser/optout.manual.js
// own-visit opt-out in a real browser: requests to /api/collect are intercepted and counted
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const tracker = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'tacilytics.js'), 'utf8');
  const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
  const hits = [];
  await ctx.route('https://an.test/tacilytics.js', r => r.fulfill({ body: tracker, contentType: 'application/javascript' }));
  await ctx.route('https://an.test/api/collect', r => { hits.push(r.request().postData()); r.fulfill({ status: 204 }); });
  await ctx.route('https://shop.test/**', r => r.fulfill({ contentType: 'text/html', body: '<html><body><script defer data-domain="shop.test" src="https://an.test/tacilytics.js"></script><a id="o" href="https://other.test/x">x</a></body></html>' }));
  const go = async (u) => { await p.goto(u); await p.waitForTimeout(400); await p.evaluate(() => window.tacilytics && window.tacilytics('Signup')); await p.waitForTimeout(400); };
  const res = {};
  await go('https://shop.test/a'); res.normal = hits.length;            // pageview + Signup
  hits.length = 0; await go('https://shop.test/b?tacilytics=off'); res.offPage = hits.length;
  hits.length = 0; await go('https://shop.test/c'); res.afterOff = hits.length;
  res.tacilyticsIsFn = await p.evaluate(() => typeof window.tacilytics);
  hits.length = 0; await go('https://shop.test/d?tacilytics=on'); res.onPage = hits.length;
  hits.length = 0; await go('https://shop.test/e'); res.afterOn = hits.length;
  console.log(JSON.stringify(res));
  const want = { normal: 2, offPage: 0, afterOff: 0, tacilyticsIsFn: 'function', onPage: 2, afterOn: 2 };
  const bad = Object.keys(want).filter((k) => res[k] !== want[k]);
  if (bad.length) { console.error('FAIL', bad.join(', ')); process.exitCode = 1; } else console.log('ok');
  await b.close();
})();
