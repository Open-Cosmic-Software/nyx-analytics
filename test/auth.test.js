'use strict';
// Accounts, team, TOTP and passkeys — end to end against a real server.js on a tmp DB.
// Passkeys are exercised with a small software authenticator (P-256, "none" attestation),
// so registration and sign-in go through the real @simplewebauthn verification.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { _test: A } = require('../auth');

const ROOT = path.join(__dirname, '..');

// ── unit: TOTP against RFC 6238 test vectors (SHA1, 6 digits = last 6 of the 8-digit values) ──
test('TOTP matches RFC 6238 vectors', () => {
  const secret = A.base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(A.totpAt(secret, Math.floor(59 / 30)), '287082');
  assert.strictEqual(A.totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.strictEqual(A.totpAt(secret, Math.floor(1234567890 / 30)), '005924');
  assert.strictEqual(A.totpAt(secret, Math.floor(2000000000 / 30)), '279037');
  assert.ok(A.totpCheck(secret, '287082', 59 * 1000) >= 0);
  assert.strictEqual(A.totpCheck(secret, '287083', 59 * 1000), -1);
  assert.strictEqual(A.totpCheck(secret, 'abcdef', 59 * 1000), -1);
});
test('base32 round trip + password hashing', () => {
  const b = crypto.randomBytes(20);
  assert.deepStrictEqual(A.base32Decode(A.base32Encode(b)), b);
  const h = A.hashPassword('correct horse');
  assert.ok(A.verifyPassword('correct horse', h));
  assert.ok(!A.verifyPassword('correct horsf', h));
  assert.ok(!A.verifyPassword('x', 'garbage'));
  const codes = A.newRecoveryCodes();
  assert.strictEqual(codes.length, 10);
  assert.strictEqual(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
});

// ── tiny CBOR encoder (only what WebAuthn needs) ──
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}
const b64u = (b) => Buffer.from(b).toString('base64url');

class SoftAuthenticator {
  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey; this.jwk = publicKey.export({ format: 'jwk' });
    this.credId = crypto.randomBytes(32); this.counter = 0; this.userHandle = null;
  }
  create(options, origin) {
    this.userHandle = options.user.id;
    const rpHash = crypto.createHash('sha256').update(options.rp.id).digest();
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x, 'base64url')], [-3, Buffer.from(this.jwk.y, 'base64url')]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.credId, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] } };
  }
  get(options, origin, rpID = options.rpId) {
    this.counter++;
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const authData = Buffer.concat([crypto.createHash('sha256').update(rpID).digest(), Buffer.from([0x05]), cnt]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const sig = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), this.priv);
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: this.userHandle } };
  }
}

// ── e2e ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-auth-'));
const DB_PATH = path.join(dir, 'analytics.db');
const PORT = 41000 + Math.floor(Math.random() * 1000);
const ORIGIN = `http://localhost:${PORT}`;
const WEB_PASSWORD = 'legacy-' + crypto.randomBytes(6).toString('hex');
const ENV = {
  ...process.env, DB_PATH, PORT: String(PORT), DIGEST_WEBHOOK_URL: 'http://127.0.0.1:9/', DATA_RETENTION_DAYS: '0',
  INGEST_SALT: 'auth-test-salt', API_KEY: 'auth-test-key', SESSION_SECRET: 'auth-test-session', WEB_PASSWORD,
  TACILYTICS_ORIGIN: ORIGIN,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null;
async function start() {
  proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/nyx.js`); return; } catch { await sleep(100); } }
  throw new Error('server did not start: ' + err);
}
async function stop() { if (!proc) return; const p = proc; proc = null; if (p.exitCode === null) { p.kill('SIGTERM'); await new Promise((r) => p.on('exit', r)); } }
let ipN = 0;
async function call(method, p, { token, body, key } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${(ipN++ % 250) + 1}` };
  if (token) headers['x-session-token'] = token;
  if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const totpNow = (secret, offset = 0) => A.totpAt(secret, Math.floor(Date.now() / 30000) + offset);

test('accounts, roles, TOTP, passkeys (real server.js)', async (t) => {
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await start();
  for (const d of ['a.test', 'b.test']) await call('POST', '/api/sites', { key: 'auth-test-key', body: { domain: d } });
  const sites = (await call('GET', '/api/sites', { key: 'auth-test-key' })).j;
  const idA = sites.find((s) => s.domain === 'a.test').id;

  // legacy mode
  let r = await call('GET', '/auth/status');
  await t.test('fresh install: no accounts', () => assert.strictEqual(r.j.accounts, false));
  r = await call('POST', '/auth/login', { body: { password: 'nope' } });
  await t.test('legacy: wrong passphrase → 401', () => assert.strictEqual(r.status, 401));
  r = await call('POST', '/auth/login', { body: { password: WEB_PASSWORD } });
  const legacy = r.j.token;
  await t.test('legacy: WEB_PASSWORD signs in', () => assert.ok(legacy));
  r = await call('POST', '/api/team/invites', { token: legacy, body: { role: 'viewer' } });
  await t.test('no invites before the first account exists', () => assert.strictEqual(r.status, 400));
  r = await call('POST', '/api/team/bootstrap', { token: legacy, body: { username: 'fabi', password: 'short' } });
  await t.test('bootstrap: short password rejected', () => assert.strictEqual(r.status, 400));
  r = await call('POST', '/api/team/bootstrap', { token: legacy, body: { username: 'fabi', password: 'owner-password-1' } });
  let owner = r.j.token;
  await t.test('bootstrap creates the owner and signs them in', () => assert.ok(owner));
  r = await call('GET', '/api/sites', { token: legacy });
  await t.test('legacy session ends once accounts exist', () => assert.strictEqual(r.status, 401));
  r = await call('POST', '/auth/login', { body: { password: WEB_PASSWORD } });
  await t.test('WEB_PASSWORD no longer opens anything', () => assert.strictEqual(r.status, 401));
  r = await call('POST', '/api/team/bootstrap', { token: owner, body: { username: 'x2', password: 'owner-password-2' } });
  await t.test('bootstrap only once', () => assert.strictEqual(r.status, 409));
  r = await call('POST', '/auth/login', { body: { username: 'FABI', password: 'owner-password-1' } });
  await t.test('username is case-insensitive', () => assert.ok(r.j.token));
  r = await call('POST', '/auth/login', { body: { username: 'ghost', password: 'owner-password-1' } });
  await t.test('unknown user → same 401 as wrong password', () => assert.strictEqual(r.j.error, 'Wrong username or password'));

  // invites + roles
  r = await call('POST', '/api/team/invites', { token: owner, body: { role: 'viewer', sites: [idA] } });
  const viewerInvite = r.j.url.split('/').pop();
  r = await call('GET', '/api/invite/' + viewerInvite);
  await t.test('invite link resolves to its role', () => assert.strictEqual(r.j.role, 'viewer'));
  r = await call('POST', '/api/invite/' + viewerInvite, { body: { username: 'fabi', password: 'viewer-password-1' } });
  await t.test('taken username rejected', () => assert.strictEqual(r.status, 409));
  r = await call('POST', '/api/invite/' + viewerInvite, { body: { username: 'vera', password: 'viewer-password-1' } });
  const viewer = r.j.token;
  await t.test('invite creates the account', () => assert.ok(viewer));
  r = await call('POST', '/api/invite/' + viewerInvite, { body: { username: 'vera2', password: 'viewer-password-1' } });
  await t.test('invite link works only once', () => assert.strictEqual(r.status, 404));
  r = await call('GET', '/api/sites', { token: viewer });
  await t.test('viewer sees only their site', () => assert.deepStrictEqual(r.j.map((s) => s.domain), ['a.test']));
  await t.test('viewer: stats of own site ok', async () => assert.strictEqual((await call('GET', '/api/stats?site=a.test', { token: viewer })).status, 200));
  await t.test('viewer: stats of other site 403', async () => assert.strictEqual((await call('GET', '/api/stats?site=b.test', { token: viewer })).status, 403));
  await t.test('viewer: realtime/journeys of other site 403', async () => {
    assert.strictEqual((await call('GET', '/api/realtime?site=b.test', { token: viewer })).status, 403);
    assert.strictEqual((await call('GET', '/api/journeys?site=b.test', { token: viewer })).status, 403);
  });
  await t.test('viewer: cannot add sites, shares, funnels or see the team', async () => {
    assert.strictEqual((await call('POST', '/api/sites', { token: viewer, body: { domain: 'c.test' } })).status, 403);
    assert.strictEqual((await call('POST', '/api/shares', { token: viewer, body: { site: 'a.test' } })).status, 403);
    assert.strictEqual((await call('POST', '/api/funnels', { token: viewer, body: { site: 'a.test', name: 'f', steps: [{ value: '/' }, { value: '/x' }] } })).status, 403);
    assert.strictEqual((await call('GET', '/api/team', { token: viewer })).status, 403);
  });
  r = await call('POST', '/api/team/invites', { token: owner, body: { role: 'admin' } });
  r = await call('POST', '/api/invite/' + r.j.url.split('/').pop(), { body: { username: 'adam', password: 'admin-password-1' } });
  const admin = r.j.token;
  await t.test('admin: may add sites, may not manage the team', async () => {
    assert.strictEqual((await call('POST', '/api/sites', { token: admin, body: { domain: 'c.test' } })).status, 200);
    assert.strictEqual((await call('GET', '/api/team', { token: admin })).status, 403);
    assert.strictEqual((await call('POST', '/api/team/invites', { token: admin, body: { role: 'owner' } })).status, 403);
  });
  const team = (await call('GET', '/api/team', { token: owner })).j;
  const fabiId = team.users.find((u) => u.username === 'fabi').id;
  r = await call('PATCH', '/api/team/users/' + fabiId, { token: owner, body: { role: 'viewer' } });
  await t.test('last owner cannot be demoted', () => assert.strictEqual(r.status, 400));
  r = await call('DELETE', '/api/team/users/' + fabiId, { token: owner });
  await t.test('last owner cannot be removed', () => assert.strictEqual(r.status, 400));
  await t.test('API key keeps owner rights', async () => assert.strictEqual((await call('GET', '/api/team', { key: 'auth-test-key' })).status, 200));

  // TOTP
  r = await call('POST', '/api/me/totp/setup', { token: owner });
  const secret = r.j.secret;
  await t.test('TOTP setup returns secret, otpauth URI and a QR code', () => {
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(r.j.uri, /^otpauth:\/\/totp\//);
    assert.match(r.j.qr, /^data:image\/svg\+xml;base64,/);
  });
  r = await call('POST', '/api/me/totp/enable', { token: owner, body: { code: '000000' === totpNow(secret) ? '111111' : '000000' } });
  await t.test('TOTP: wrong code does not enable', () => assert.strictEqual(r.status, 401));
  const enableCode = totpNow(secret);
  r = await call('POST', '/api/me/totp/enable', { token: owner, body: { code: enableCode } });
  const recovery = r.j.recoveryCodes;
  await t.test('TOTP enabled, 10 recovery codes', () => assert.strictEqual(recovery.length, 10));
  r = await call('POST', '/auth/login', { body: { username: 'fabi', password: 'owner-password-1' } });
  await t.test('password alone is not enough any more', () => { assert.strictEqual(r.j.mfa, 'totp'); assert.ok(!r.j.token); });
  let ticket = r.j.ticket;
  r = await call('POST', '/auth/login/totp', { body: { ticket, code: enableCode } });
  await t.test('TOTP: the same code cannot be used twice', () => assert.strictEqual(r.status, 401));
  ticket = r.j.ticket;
  r = await call('POST', '/auth/login/totp', { body: { ticket, code: recovery[0].toUpperCase() } });
  owner = r.j.token;
  await t.test('recovery code signs in (case-insensitive)', () => assert.ok(owner));
  r = await call('POST', '/auth/login', { body: { username: 'fabi', password: 'owner-password-1' } });
  r = await call('POST', '/auth/login/totp', { body: { ticket: r.j.ticket, code: recovery[0] } });
  await t.test('recovery code works only once', () => assert.strictEqual(r.status, 401));
  r = await call('POST', '/auth/login/totp', { body: { ticket: 'made-up', code: '123456' } });
  await t.test('TOTP step needs a valid ticket', () => assert.strictEqual(r.status, 401));
  r = await call('GET', '/api/me', { token: owner });
  await t.test('/api/me shows 2FA on and 9 recovery codes left', () => { assert.strictEqual(r.j.totp, true); assert.strictEqual(r.j.recoveryLeft, 9); });

  // passkeys
  const key = new SoftAuthenticator();
  r = await call('POST', '/api/me/passkeys/options', { token: owner });
  const regOpts = r.j.options;
  await t.test('passkey options carry rp id + user handle', () => { assert.strictEqual(regOpts.rp.id, 'localhost'); assert.ok(regOpts.user.id); });
  r = await call('POST', '/api/me/passkeys', { token: owner, body: { ticket: r.j.ticket, response: key.create(regOpts, ORIGIN), name: 'Test key' } });
  await t.test('passkey registered', () => assert.strictEqual(r.status, 200, JSON.stringify(r.j)));
  r = await call('POST', '/auth/passkey/options');
  r = await call('POST', '/auth/passkey/verify', { body: { ticket: r.j.ticket, response: key.get(r.j.options, ORIGIN) } });
  const viaPasskey = r.j.token;
  await t.test('passkey signs in without password or TOTP', () => assert.ok(viaPasskey, JSON.stringify(r.j)));
  await t.test('passkey session is the owner', async () => assert.strictEqual((await call('GET', '/api/me', { token: viaPasskey })).j.username, 'fabi'));
  r = await call('POST', '/auth/passkey/options');
  r = await call('POST', '/auth/passkey/verify', { body: { ticket: r.j.ticket, response: key.get(r.j.options, 'https://evil.example') } });
  await t.test('passkey from another origin is rejected', () => assert.strictEqual(r.status, 401));
  r = await call('POST', '/auth/passkey/options');
  r = await call('POST', '/auth/passkey/verify', { body: { ticket: r.j.ticket, response: key.get(r.j.options, ORIGIN, 'evil.example') } });
  await t.test('passkey signed for another rpID is rejected', () => assert.strictEqual(r.status, 401));
  r = await call('POST', '/auth/passkey/options');
  const opts = r.j.options;
  const resp = key.get(opts, ORIGIN);
  await call('POST', '/auth/passkey/verify', { body: { ticket: r.j.ticket, response: resp } });
  r = await call('POST', '/auth/passkey/verify', { body: { ticket: r.j.ticket, response: resp } });
  await t.test('a passkey challenge cannot be replayed', () => assert.strictEqual(r.status, 401));
  const stranger = new SoftAuthenticator();
  r = await call('POST', '/auth/passkey/options');
  r = await call('POST', '/auth/passkey/verify', { body: { ticket: r.j.ticket, response: stranger.get(r.j.options, ORIGIN) } });
  await t.test('unknown passkey is rejected', () => assert.strictEqual(r.status, 401));

  // storage + restart
  await stop();
  await t.test('no plain session token, invite token or recovery code in the DB', () => {
    const raw = fs.readFileSync(DB_PATH).toString('latin1') + (fs.existsSync(DB_PATH + '-wal') ? fs.readFileSync(DB_PATH + '-wal').toString('latin1') : '');
    for (const s of [owner, viaPasskey, viewer, viewerInvite, recovery[1], 'owner-password-1']) assert.ok(!raw.includes(s), 'found plain secret in DB');
  });
  await start();
  await t.test('sessions survive a restart', async () => assert.strictEqual((await call('GET', '/api/me', { token: owner })).status, 200));

  // lock-out recovery via CLI
  await stop();
  const out = execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), 'reset-login', 'fabi'], { env: ENV, encoding: 'utf8' });
  const newPw = (out.match(/New password: (\S+)/) || [])[1];
  await t.test('CLI reset-login prints a new password', () => assert.ok(newPw, out));
  await start();
  await t.test('after reset: old sessions gone, new password works without 2FA', async () => {
    assert.strictEqual((await call('GET', '/api/me', { token: owner })).status, 401);
    const x = await call('POST', '/auth/login', { body: { username: 'fabi', password: newPw } });
    assert.ok(x.j.token, JSON.stringify(x.j));
  });
});
