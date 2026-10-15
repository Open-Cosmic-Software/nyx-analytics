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
    const answer = list[Math.min((seen[host] = (seen[host] || 0) + 1), list.length) - 1];
    // an answer may be one address or several (a name with A records [public, 127.0.0.1])
    const all = (Array.isArray(answer) ? answer : [answer]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    return opts.all ? cb(null, all) : cb(null, all[0].address, all[0].family);
  };
}

test('Kiro (iii) / Tyto: DNS rebinding: public at the check, 127.0.0.1 at connect → refused, nothing arrives', async (t) => {
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
test('one guard for both paths: webhookProblem and the connect-time lookup use isPrivateAddress', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'webhook.js'), 'utf8');
  assert.strictEqual((src.match(/PRIVATE_V4 = \[/g) || []).length, 1, 'exactly one range list');
  assert.match(src.slice(src.indexOf('function webhookProblem')), /isPrivateAddress\(h\)/);
  assert.match(src.slice(src.indexOf('function makeGuardedLookup')), /list\.some\(\(x\) => isPrivateAddress\(x\.address\)\)/);
});
test('Kiro: a trailing dot does not hide localhost / internal names', () => {
  for (const u of ['https://localhost./', 'https://foo.localhost./', 'https://printer.local./', 'https://db.internal./', 'https://intranet./', 'https://localhost../'])
    assert.strictEqual(webhookProblem(u), 'Webhook must point to a public address', u);
  assert.strictEqual(webhookProblem('https://example.com./hook'), null, 'a public FQDN with trailing dot stays allowed');
});
test('Kiro (i): IP literal https://[64:ff9b::7f00:1]/ is refused by webhookProblem (Node skips lookup for literals)', () => {
  for (const u of ['https://[64:ff9b::7f00:1]/', 'https://198.18.0.1/', 'https://[fec0::1]/', 'https://224.0.0.1/', 'https://[::ffff:127.0.0.1]/'])
    assert.ok(webhookProblem(u), u);
});
test('Kiro (ii): a name resolving to [public, 127.0.0.1] is refused — every address counts, not the first', async () => {
  const mixed = fakeDns({ 'hook.test': [['93.184.216.34', '127.0.0.1']] });
  assert.strictEqual(await resolvesPublic('https://hook.test/x', mixed), false);
  await assert.rejects(postJson('https://hook.test:1/x', {}, { lookup: mixed }), (e) => e.code === 'EWEBHOOKPRIVATE');
  // both lookup forms: Node 22 asks with {all:true}, older callers without
  const { makeGuardedLookup } = require('../webhook');
  const g = makeGuardedLookup(mixed);
  for (const opts of [{ all: true }, {}]) {
    const err = await new Promise((r) => g('hook.test', opts, (e) => r(e)));
    assert.strictEqual(err && err.code, 'EWEBHOOKPRIVATE', JSON.stringify(opts));
  }
  const ok = makeGuardedLookup(fakeDns({ 'pub.test': [['93.184.216.34', '2606:4700::1111']] }));
  const arr = await new Promise((r) => ok('pub.test', { all: true }, (e, a) => r(e || a)));
  assert.strictEqual(arr.length, 2);
  const one = await new Promise((r) => ok('pub.test', {}, (e, a, f) => r(e || [a, f])));
  assert.deepStrictEqual(one, ['93.184.216.34', 4]);
});
test('IP literal in a private range is refused before connecting', async () => {
  await assert.rejects(postJson('https://127.0.0.1:1/x', {}), (e) => e.code === 'EWEBHOOKPRIVATE');
  await assert.rejects(postJson('https://[64:ff9b::7f00:1]:1/x', {}), (e) => e.code === 'EWEBHOOKPRIVATE');
});

// Kiro (Node 22 calls lookup with {all:true} because of autoSelectFamily): every address in the
// array must be checked, not only the first; both call forms must work.
test('lookup returning [public, 127.0.0.1] → refused, in both call forms', async () => {
  const { makeGuardedLookup } = require('../webhook');
  const multi = (host, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = {}; }
    const list = [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    return opts.all ? cb(null, list) : cb(null, list[0].address, 4); };
  const g = makeGuardedLookup(multi);
  for (const opts of [{ all: true }, {}]) {
    const err = await new Promise((r) => g('hook.test', opts, (e) => r(e)));
    assert.ok(err && err.code === 'EWEBHOOKPRIVATE', JSON.stringify(opts));
  }
  assert.strictEqual(await resolvesPublic('https://hook.test/x', multi), false);
  await assert.rejects(postJson('https://hook.test:1/x', {}, { lookup: multi }), (e) => e.code === 'EWEBHOOKPRIVATE');
  // and a purely public answer still passes, in both forms
  const pub = (host, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = {}; } return opts.all ? cb(null, [{ address: '93.184.216.34', family: 4 }]) : cb(null, '93.184.216.34', 4); };
  const g2 = makeGuardedLookup(pub);
  assert.deepStrictEqual(await new Promise((r) => g2('x.test', { all: true }, (e, a) => r(e || a))), [{ address: '93.184.216.34', family: 4 }]);
  assert.deepStrictEqual(await new Promise((r) => g2('x.test', {}, (e, a, f) => r(e || [a, f]))), ['93.184.216.34', 4]);
});
test('IP literals never reach lookup → webhookProblem is the only gate for them', () => {
  for (const u of ['https://198.18.0.1/x', 'https://[64:ff9b::7f00:1]/x', 'https://[fec0::1]/x', 'https://224.0.0.1/x', 'https://240.0.0.1/x', 'https://[::ffff:127.0.0.1]/x'])
    assert.ok(webhookProblem(u), u + ' must be refused by webhookProblem itself');
});
