'use strict';
// SSRF guard for dashboard webhooks (webhook.js): address ranges, and the connect-time check
// that stops DNS rebinding (public on the first lookup, 127.0.0.1 on the second).
const { test } = require('node:test');
const assert = require('node:assert');
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webhookProblem, isPrivateAddress, resolvesPublic, postJson } = require('../webhook');

test('private / special ranges are refused, public ones pass', () => {
  const bad = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1'];
  for (const a of bad) assert.ok(isPrivateAddress(a), a + ' should be private');
  const good = ['1.1.1.1', '8.8.8.8', '172.32.0.1', '198.20.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:1.1.1.1', '2002:101:101::1'];
  for (const a of good) assert.ok(!isPrivateAddress(a), a + ' should be public');
});
test('webhookProblem: URL-level checks', () => {
  for (const u of ['http://example.com/x', 'https://localhost/x', 'https://intranet/x', 'https://a.internal/x', 'https://[64:ff9b::7f00:1]/x', 'https://198.18.0.5/x', 'https://[fec0::1]/x', 'nope'])
    assert.ok(webhookProblem(u), u);
  assert.strictEqual(webhookProblem('https://discord.com/api/webhooks/1/x'), null);
});

// fake resolver: answers per name in turn (last answer repeats)
function fakeDns(table) {
  const seen = {};
  return (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const list = table[host]; if (!list) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const address = list[Math.min((seen[host] = (seen[host] || 0) + 1), list.length) - 1];
    const family = address.includes(':') ? 6 : 4;
    return opts.all ? cb(null, [{ address, family }]) : cb(null, address, family);
  };
}

test('DNS rebinding: public at the check, 127.0.0.1 at connect → refused, nothing arrives', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-wh-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem', '-days', '1', '-subj', '/CN=hook.test'], { stdio: 'ignore' });
  let hits = 0;
  const srv = https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, (req, res) => { hits++; res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = srv.address().port;
  const url = `https://hook.test:${port}/x`;
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed test cert
  t.after(() => { if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev; });

  const rebind = fakeDns({ 'hook.test': ['93.184.216.34', '127.0.0.1'] });
  assert.strictEqual(await resolvesPublic(url, rebind), true, 'first answer is public — the pre-check passes');
  await assert.rejects(postJson(url, { a: 1 }, { lookup: rebind }), (e) => e.code === 'EWEBHOOKPRIVATE');
  assert.strictEqual(hits, 0, 'the private receiver must not be reached');

  // control: the same receiver IS reachable when the guard is not in the way (proves the test can go red)
  const direct = await new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', lookup: fakeDns({ 'hook.test': ['127.0.0.1'] }), agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('{}');
  });
  assert.strictEqual(direct, 200); assert.strictEqual(hits, 1);
});
test('IP literal in a private range is refused before connecting', async () => {
  await assert.rejects(postJson('https://127.0.0.1:1/x', {}), (e) => e.code === 'EWEBHOOKPRIVATE');
  await assert.rejects(postJson('https://[64:ff9b::7f00:1]:1/x', {}), (e) => e.code === 'EWEBHOOKPRIVATE');
});
