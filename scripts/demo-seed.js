// Usage: DB_PATH=/tmp/demo.db PORT=3998 node server.js (once, to create the schema), stop it, then: node scripts/demo-seed.js /tmp/demo.db
// demo data for README screenshots — fictional shop, no real visitors
const D = require('better-sqlite3');
const db = new D(process.argv[2]);
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const w = (pairs) => { const t = pairs.reduce((s, p) => s + p[1], 0); let r = Math.random() * t; for (const p of pairs) { if ((r -= p[1]) < 0) return p[0]; } return pairs[0][0]; };
db.prepare("insert into sites(domain,name,created) values('demo-shop.example','Demo Shop',?)").run(Date.now() - 90 * 864e5);
const sid = db.prepare("select id from sites where domain='demo-shop.example'").get().id;
const ins = db.prepare('insert into events(site_id,ts,day,path,source,referrer,country,tz,browser,os,device,lang,vh,name,utm_medium,utm_campaign,dur,props,scroll,platform,app_version) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const pages = [['/', 40], ['/shop', 22], ['/products/linen-shirt', 12], ['/products/wool-scarf', 9], ['/products/canvas-tote', 8], ['/cart', 7], ['/checkout', 5], ['/blog/how-we-dye', 4], ['/about', 3], ['/pricing', 3]];
const sources = [['Direct', 30], ['google.com', 28], ['instagram.com', 9], ['duckduckgo.com', 5], ['youtube.com', 4], ['reddit.com', 4], ['ecosia.org', 3], ['t.co', 3], ['pinterest.com', 3], ['newsletter', 4]];
const countries = [['DE', 34], ['US', 16], ['GB', 9], ['FR', 8], ['NL', 6], ['AT', 6], ['CH', 5], ['IT', 4], ['ES', 4], ['SE', 3], ['CA', 3], ['JP', 2]];
const tz = { DE: 'Europe/Berlin', US: 'America/New_York', GB: 'Europe/London', FR: 'Europe/Paris', NL: 'Europe/Amsterdam', AT: 'Europe/Vienna', CH: 'Europe/Zurich', IT: 'Europe/Rome', ES: 'Europe/Madrid', SE: 'Europe/Stockholm', CA: 'America/Toronto', JP: 'Asia/Tokyo' };
const now = Date.now();
db.transaction(() => {
  for (let d = 65; d >= 0; d--) {
    const dayStart = new Date(now - d * 864e5); dayStart.setUTCHours(0, 0, 0, 0);
    const wave = 1 + 0.35 * Math.sin(d / 3.2) + (65 - d) * 0.006;
    const visitors = Math.round(170 * wave + Math.random() * 30);
    for (let v = 0; v < visitors; v++) {
      const vh = Math.random().toString(36).slice(2, 14);
      const app = Math.random() < 0.22;
      const platform = app ? w([['android', 60], ['ios', 40]]) : 'web';
      const device = app ? 'Mobile' : w([['Mobile', 58], ['Desktop', 36], ['Tablet', 6]]);
      const os = app ? (platform === 'ios' ? 'iOS' : 'Android') : device === 'Desktop' ? w([['Windows', 55], ['macOS', 35], ['Linux', 10]]) : w([['Android', 55], ['iOS', 45]]);
      const browser = app ? 'App' : os === 'iOS' || os === 'macOS' ? w([['Safari', 75], ['Chrome', 25]]) : w([['Chrome', 62], ['Firefox', 14], ['Samsung', 10], ['Edge', 9], ['Opera', 5]]);
      const cc = w(countries); const src = w(sources);
      const lang = { DE: 'de', AT: 'de', CH: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl', SE: 'sv', JP: 'ja' }[cc] || 'en';
      let ts = dayStart.getTime() + Math.floor((7 + Math.random() * 16) * 3600e3);
      if (ts > now) ts = now - Math.floor(Math.random() * 25 * 60e3);
      const day = new Date(ts).toISOString().slice(0, 10);
      const n = 1 + Math.floor(Math.random() * 4);
      let path = w(pages);
      for (let i = 0; i < n; i++) {
        ins.run(sid, ts, day, path, i === 0 ? src : 'Direct', null, cc, tz[cc], browser, os, device, lang, vh, null, src === 'newsletter' ? 'email' : null, src === 'newsletter' ? 'autumn-drop' : null, 10 + Math.floor(Math.random() * 150), null, 30 + Math.floor(Math.random() * 70), platform, app ? '2.4.1' : null);
        ts += 20e3 + Math.random() * 90e3; path = w(pages);
      }
      if (Math.random() < 0.035) ins.run(sid, ts, day, '/checkout/done', 'Direct', null, cc, tz[cc], browser, os, device, lang, vh, 'Purchase', null, null, null, JSON.stringify({ value: String((19 + Math.random() * 120).toFixed(2)), currency: 'EUR' }), null, platform, app ? '2.4.1' : null);
      else if (Math.random() < 0.05) ins.run(sid, ts, day, '/', 'Direct', null, cc, tz[cc], browser, os, device, lang, vh, 'Newsletter signup', null, null, null, null, null, platform, null);
      if (Math.random() < 0.06) ins.run(sid, ts, day, '/search', 'Direct', null, cc, tz[cc], browser, os, device, lang, vh, 'Search', null, null, null, JSON.stringify({ q: rnd(['linen', 'scarf', 'tote bag', 'gift card', 'size guide']), results: '4' }), null, platform, null);
    }
  }
})();
console.log('seeded', db.prepare('select count(*) c from events').get().c);
