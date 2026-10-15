'use strict';
// SSRF guard for webhooks typed into the dashboard (alerts are sent by the server, so a
// teammate must not be able to point them at internal services).
//
// Two layers:
//  1. webhookProblem / resolvesPublic — friendly errors when the alert is saved.
//  2. postJson — the connection itself goes through guardedLookup, so the address that is
//     actually dialled is checked. Without this a name could resolve to a public IP for the
//     check and to 127.0.0.1 a moment later for the request (DNS rebinding / TOCTOU).
// No redirects are followed. The operator's own DIGEST_WEBHOOK_URL does not come through here.

const dns = require('dns');
const https = require('https');
const net = require('net');

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4num = (a) => a.split('.').reduce((n, x) => n * 256 + Number(x), 0);
function privateV4(a) {
  const n = v4num(a);
  return PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4num(base) / 2 ** (32 - bits)));
}
// IPv6 → 8 groups of 16 bit (handles ::, embedded IPv4)
function v6groups(a) {
  let s = a.toLowerCase().split('%')[0];
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const n = v4num(m[1]); s = s.slice(0, -m[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16); }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail != null && tail !== '' ? tail.split(':') : [];
  const fill = tail != null ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}
function privateV6(a) {
  const g = v6groups(a);
  if (g.length !== 8 || g.some((x) => !Number.isFinite(x))) return true;
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(embedded()); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::a.b.c.d (deprecated, compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 + /48 NAT64 — would reach an IPv4 behind the gateway
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return privateV4(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4
  return false;
}
function isPrivateAddress(a) {
  const v = net.isIP(a);
  if (v === 4) return privateV4(a);
  if (v === 6) return privateV6(a);
  return true; // not an address at all → refuse
}

function webhookProblem(u) {
  let url; try { url = new URL(String(u)); } catch { return 'Enter a full https:// URL'; }
  if (url.protocol !== 'https:') return 'Webhook must use https://';
  // 'localhost.' / 'foo.localhost.' are the same names (fully-qualified, trailing dot) — strip it before comparing
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (net.isIP(h)) return isPrivateAddress(h) ? 'Webhook must point to a public address' : null;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return 'Webhook must point to a public address';
  return null;
}

// dns.lookup signature, but refuses if any resolved address is private
function makeGuardedLookup(lookup = dns.lookup) {
  return function guardedLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      if (!list.length || list.some((x) => isPrivateAddress(x.address))) {
        const e = new Error('Webhook address is not public'); e.code = 'EWEBHOOKPRIVATE'; return cb(e);
      }
      if (options && options.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

async function resolvesPublic(u, lookup = dns.lookup) {
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return !isPrivateAddress(h);
  return new Promise((resolve) => makeGuardedLookup(lookup)(h, { all: true }, (err) => resolve(!err)));
}

// POST JSON over https with the guarded lookup. Resolves { ok, status } or rejects.
function postJson(u, body, { lookup = dns.lookup, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(u);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host)) return reject(Object.assign(new Error('Webhook address is not public'), { code: 'EWEBHOOKPRIVATE' }));
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method: 'POST', lookup: makeGuardedLookup(lookup), timeout, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'Tacilytics' },
    }, (res) => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode })); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { webhookProblem, isPrivateAddress, makeGuardedLookup, resolvesPublic, postJson };
