/* Tacilytics — sign-in (passphrase / account / TOTP / passkey), invites, Settings (security + team).
   Loaded before app.js; uses window.Taci (api, esc, ico, signedIn, sites) lazily. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var T = function () { return window.Taci; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ico = function (id) { return '<svg class="ico ui" aria-hidden="true"><use href="/assets/icons.svg?v=2#' + id + '"></use></svg>'; };
  var hasPasskeys = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);

  function post(path, body, token) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['x-session-token'] = token;
    return fetch(path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); });
  }
  // a body that is not JSON (e.g. the SPA page from a server that lacks the route) is an ERROR, never {} —
  // {} or a string would reach rows.map / t.users and break far from the cause (Kiro, 2.2.0)
  function readJson(r) {
    var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
    if (!/\bjson\b/i.test(ct)) return Promise.reject(new Error(r.ok ? 'Server did not answer with JSON (HTTP ' + r.status + ')' : 'HTTP ' + r.status));
    return r.json().catch(function () { throw new Error('Server did not answer with JSON (HTTP ' + r.status + ')'); });
  }
  // authenticated calls that also report errors (Taci.api only throws on 401)
  function call(method, path, body) {
    return fetch(path, { method: method, headers: { 'Content-Type': 'application/json', 'x-session-token': localStorage.getItem('nyx_token') || '' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return readJson(r).then(function (j) { if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); });
  }

  // ── WebAuthn: JSON options (base64url) ⇄ browser ArrayBuffers ──
  function b64uToBuf(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
  function bufToB64u(buf) { var u = new Uint8Array(buf), s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function pkCreate(o) {
    var pub = Object.assign({}, o, {
      challenge: b64uToBuf(o.challenge),
      user: Object.assign({}, o.user, { id: b64uToBuf(o.user.id) }),
      excludeCredentials: (o.excludeCredentials || []).map(function (c) { return Object.assign({}, c, { id: b64uToBuf(c.id) }); }),
    });
    return navigator.credentials.create({ publicKey: pub }).then(function (c) {
      return {
        id: c.id, rawId: bufToB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
        authenticatorAttachment: c.authenticatorAttachment || undefined,
        response: {
          clientDataJSON: bufToB64u(c.response.clientDataJSON), attestationObject: bufToB64u(c.response.attestationObject),
          transports: c.response.getTransports ? c.response.getTransports() : undefined,
        },
      };
    });
  }
  function pkGet(o) {
    var pub = Object.assign({}, o, { challenge: b64uToBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map(function (c) { return Object.assign({}, c, { id: b64uToBuf(c.id) }); }) });
    return navigator.credentials.get({ publicKey: pub }).then(function (c) {
      return {
        id: c.id, rawId: bufToB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
        authenticatorAttachment: c.authenticatorAttachment || undefined,
        response: {
          clientDataJSON: bufToB64u(c.response.clientDataJSON), authenticatorData: bufToB64u(c.response.authenticatorData),
          signature: bufToB64u(c.response.signature), userHandle: c.response.userHandle ? bufToB64u(c.response.userHandle) : undefined,
        },
      };
    });
  }
  var pkCancelled = function (e) { return e && (e.name === 'NotAllowedError' || e.name === 'AbortError'); };

  // ── sign in ──
  var accounts = false, ticket = '';
  function loginErr(t) { $('loginErr').textContent = t || ''; }
  function step(n) { $('loginStep1').classList.toggle('hide', n !== 1); $('loginStep2').classList.toggle('hide', n !== 2); }
  function prepareLogin() {
    step(1); loginErr('');
    fetch('/auth/status').then(function (r) { return r.json(); }).then(function (s) {
      accounts = !!s.accounts;
      $('user').classList.toggle('hide', !accounts);
      $('pw').placeholder = accounts ? 'Password' : 'Passphrase';
      $('loginHint').textContent = accounts ? 'Cookieless analytics. Sign in to your account.' : 'Cookieless analytics. Sign in with your passphrase.';
      $('passkeyBtn').classList.toggle('hide', !(accounts && hasPasskeys));
      (accounts ? $('user') : $('pw')).focus();
    }).catch(function () {});
  }
  function login() {
    loginErr('');
    var body = { password: $('pw').value };
    if (accounts) body.username = $('user').value.trim();
    post('/auth/login', body).then(function (r) {
      if (!r.ok) return loginErr(r.j.error || 'Wrong password');
      $('pw').value = '';
      if (r.j.mfa === 'totp') { ticket = r.j.ticket; step(2); $('otp').value = ''; $('otp').focus(); return; }
      T().signedIn(r.j.token);
    }).catch(function () { loginErr('Connection error'); });
  }
  function verifyOtp() {
    loginErr('');
    post('/auth/login/totp', { ticket: ticket, code: $('otp').value.trim() }).then(function (r) {
      if (r.ok) return T().signedIn(r.j.token);
      if (r.j.ticket) { ticket = r.j.ticket; $('otp').value = ''; $('otp').focus(); return loginErr(r.j.error || 'Wrong code'); }
      step(1); loginErr(r.j.error || 'Sign-in expired — enter your password again');
    }).catch(function () { loginErr('Connection error'); });
  }
  function passkeyLogin() {
    loginErr('');
    post('/auth/passkey/options').then(function (r) {
      if (!r.ok) throw new Error(r.j.error || 'Passkeys are not available');
      return pkGet(r.j.options).then(function (resp) { return post('/auth/passkey/verify', { ticket: r.j.ticket, response: resp }); });
    }).then(function (r) {
      if (!r.ok) return loginErr(r.j.error || 'Passkey not accepted');
      T().signedIn(r.j.token);
    }).catch(function (e) { if (!pkCancelled(e)) loginErr(e.message || 'Passkey sign-in failed'); });
  }
  $('loginBtn').onclick = login;
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
  $('user').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('pw').focus(); });
  $('otpBtn').onclick = verifyOtp;
  $('otp').addEventListener('keydown', function (e) { if (e.key === 'Enter') verifyOtp(); });
  $('passkeyBtn').onclick = passkeyLogin;

  // ── invite page ──
  function showInvite(token) {
    $('app').classList.add('hide'); $('invite').classList.remove('hide');
    fetch('/api/invite/' + token).then(function (r) { return r.json(); }).then(function (inv) {
      if (inv.error) { $('inviteHint').textContent = inv.error; $('inviteForm').classList.add('hide'); return; }
      $('inviteHint').textContent = 'You were invited as ' + ROLE_LABEL[inv.role].toLowerCase() + '. Choose a username and a password.';
      $('invUser').focus();
    });
    var go = function () {
      $('inviteErr').textContent = '';
      post('/api/invite/' + token, { username: $('invUser').value.trim(), password: $('invPw').value }).then(function (r) {
        if (!r.ok) { $('inviteErr').textContent = r.j.error || 'Could not create the account'; return; }
        history.replaceState(null, '', '/');
        $('invite').classList.add('hide');
        T().signedIn(r.j.token);
      });
    };
    $('invBtn').onclick = go;
    $('invPw').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }

  // ── password reset page ──
  function showReset(token) {
    $('app').classList.add('hide'); $('reset').classList.remove('hide');
    fetch('/api/reset/' + token).then(function (r) { return r.json(); }).then(function (r) {
      if (r.error) { $('resetHint').textContent = r.error; $('resetForm').classList.add('hide'); return; }
      $('resetHint').textContent = 'Choose a new password for ' + r.username + '.' + (r.totp ? ' Your two-factor code stays on.' : '');
      $('resetPw').focus();
    });
    var go = function () {
      $('resetErr').textContent = '';
      post('/api/reset/' + token, { password: $('resetPw').value }).then(function (r) {
        if (!r.ok) { $('resetErr').textContent = r.j.error || 'Could not save the password'; return; }
        history.replaceState(null, '', '/');
        $('reset').classList.add('hide');
        $('login').classList.remove('hide'); prepareLogin();
        setTimeout(function () { $('user').value = r.j.username; $('pw').focus(); $('loginHint').textContent = 'Password saved. Sign in with your new password.'; }, 300);
      });
    };
    $('resetBtn').onclick = go;
    $('resetPw').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }

  // ── settings ──
  var ROLE_LABEL = { owner: 'Owner', admin: 'Admin', viewer: 'Viewer' };
  var ROLE_HELP = { owner: 'everything, including the team', admin: 'sites, share links and funnels', viewer: 'read only' };
  var me = null;
  function setErr(t) { $('setErr').textContent = t || ''; }
  function afterBoot() {
    call('GET', '/api/me').then(function (m) {
      me = m;
      $('meName').textContent = m.username || 'Settings';
      document.body.classList.toggle('role-viewer', m.role === 'viewer');
    }).catch(function () {});
  }
  function openSettings(tab) {
    setErr(''); $('settingsModal').classList.remove('hide');
    call('GET', '/api/me').then(function (m) {
      me = m;
      $('setTabs').querySelector('[data-t="team"]').classList.toggle('hide', m.role !== 'owner');
      $('setTabs').querySelector('[data-t="activity"]').classList.toggle('hide', m.role !== 'owner');
      showTab(tab || 'security');
    }).catch(function (e) { setErr(e.message); });
  }
  function showTab(t) {
    Array.prototype.forEach.call($('setTabs').children, function (b) { b.classList.toggle('active', b.dataset.t === t); });
    $('setSecurity').classList.toggle('hide', t !== 'security');
    $('setTeam').classList.toggle('hide', t !== 'team');
    $('setActivity').classList.toggle('hide', t !== 'activity');
    setErr('');
    if (t === 'security') renderSecurity(); else if (t === 'team') renderTeam(); else renderActivity();
  }
  $('settingsBtn').onclick = function () { openSettings(); };
  $('closeSettings').onclick = function () { closeModal($('settingsModal')); };
  $('setTabs').onclick = function (e) { var b = e.target.closest('button'); if (b) showTab(b.dataset.t); };
  function date(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }

  // security tab
  // language + theme: per browser, for everyone (also before an account exists)
  function prefsCard() {
    var lang = window.TaciLang ? window.TaciLang.get() : 'auto';
    var theme = window.TaciTheme ? window.TaciTheme.get() : 'system';
    var opt = function (v, label, cur) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + label + '</option>'; };
    return '<div class="set-card"><h3>' + ico('i-settings') + 'Appearance</h3>' +
      '<div class="set-inline">' +
      '<label class="small muted" style="flex:0 0 auto">Language</label><select id="prefLang" style="flex:1 1 140px">' + opt('auto', 'Automatic', lang) + opt('en', 'English', lang) + opt('de', 'Deutsch', lang) + '</select>' +
      '<label class="small muted" style="flex:0 0 auto">Theme</label><select id="prefTheme" style="flex:1 1 140px">' + opt('system', 'System', theme) + opt('light', 'Light', theme) + opt('dark', 'Dark', theme) + '</select>' +
      '</div><p class="muted small" style="margin:8px 0 0">Language and appearance are saved in this browser.</p></div>';
  }
  function bindPrefs() {
    if ($('prefLang')) $('prefLang').onchange = function () { window.TaciLang.set(this.value); };
    if ($('prefTheme')) $('prefTheme').onchange = function () { window.TaciTheme.set(this.value); };
  }
  function renderSecurity() {
    var el = $('setSecurity');
    if (me.kind !== 'user') {
      // legacy passphrase (or API key): offer the first account
      el.innerHTML = prefsCard() +
        '<div class="set-card"><h3>' + ico('i-user-plus') + 'Create your account</h3>' +
        '<p class="muted">You are signed in with the shared passphrase. Create an owner account to unlock two-factor sign-in, passkeys and the team. ' +
        '<strong>After that the passphrase (WEB_PASSWORD) stops working</strong>, so 2FA cannot be bypassed.</p>' +
        '<input id="bsUser" type="text" placeholder="Username" autocomplete="username" autocapitalize="off" spellcheck="false">' +
        '<input id="bsPw" type="password" placeholder="Password (at least 10 characters)" autocomplete="new-password">' +
        '<button class="btn" id="bsBtn">Create owner account</button></div>';
      bindPrefs();
      $('bsBtn').onclick = function () {
        setErr('');
        post('/api/team/bootstrap', { username: $('bsUser').value.trim(), password: $('bsPw').value }, localStorage.getItem('nyx_token')).then(function (r) {
          if (!r.ok) return setErr(r.j.error || 'Could not create the account');
          localStorage.setItem('nyx_token', r.j.token);
          openSettings('security'); afterBoot();
        });
      };
      return;
    }
    var pk = (me.passkeyList || []).map(function (k) {
      return '<div class="set-row"><span>' + ico('i-key') + esc(k.name) + '</span><span class="muted small">added ' + date(k.created) + (k.last_used ? ' · used ' + date(k.last_used) : '') + '</span>' +
        '<button class="btn ghost danger mini" data-delpk="' + esc(k.id) + '">Remove</button></div>';
    }).join('');
    el.innerHTML = prefsCard() +
      '<div class="set-card"><h3>' + ico('i-key') + 'Passkeys <span class="pill">optional</span></h3>' +
      '<p class="muted">Sign in with Face ID, Touch ID, Windows Hello or a security key. No password, no code — and it cannot be phished.</p>' +
      (pk || '<p class="muted small">No passkey yet.</p>') +
      (hasPasskeys ? '<div class="set-inline"><input id="pkName" type="text" placeholder="Name, e.g. MacBook" maxlength="60"><button class="btn" id="pkAdd">Add passkey</button></div>'
        : '<p class="muted small">This browser does not support passkeys.</p>') +
      '</div>' +
      '<div class="set-card"><h3>' + ico('i-smartphone') + 'Two-factor code (OTP) <span class="pill">' + (me.totp ? 'on' : 'optional') + '</span></h3>' +
      (me.totp
        ? '<p class="muted">Signing in with your password also asks for a 6-digit code from your authenticator app.</p><p class="muted small"><span>Recovery codes left:</span> <strong>' + me.recoveryLeft + '</strong></p>' +
          '<div class="set-inline"><input id="totpPw" type="password" placeholder="Your password" autocomplete="current-password"><button class="btn ghost" id="newRecovery">New recovery codes</button><button class="btn ghost danger" id="totpOff">Turn off</button></div>'
        : '<p class="muted">Use any authenticator app (1Password, Google Authenticator, Authy, Bitwarden …).</p><div id="totpSetup"><button class="btn" id="totpStart">Set up</button></div>') +
      '</div>' +
      '<div class="set-card"><h3>' + ico('i-eye') + 'Don\u2019t count my own visits</h3>' +
      '<p class="muted">Open your site once with one of these links, in every browser and on every phone you use. That browser is then ignored on that site (stored in the browser, nothing on the server). The second link undoes it.</p>' +
      ((T().sites() || []).length ? '' : '<p class="muted small">Add a site first, then the links appear here. Or open any of your pages with <code>?tacilytics=off</code> at the end.</p>') +
      (T().sites() || []).map(function (st) {
        var d = 'https://' + st.domain + '/';
        return '<div class="set-row"><span>' + esc(st.domain) + '</span>' +
          '<a class="btn ghost mini" target="_blank" rel="noopener" href="' + esc(d + '?tacilytics=off') + '">Ignore this browser</a>' +
          '<a class="btn ghost mini" target="_blank" rel="noopener" href="' + esc(d + '?tacilytics=on') + '">Count again</a></div>';
      }).join('') +
      '</div>' +
      '<div class="set-card"><h3>' + ico('i-calendar') + 'Weekly report <span class="pill">e-mail</span></h3>' +
      '<p class="muted">Every Monday morning, for each of your sites: key figures, a day-by-day chart, highlights, top pages, sources, countries, devices, goals, shop numbers and your notes — compared with the week before.</p>' +
      '<div id="repBox"><p class="muted small">Loading…</p></div></div>' +
      '<div class="set-card"><h3>' + ico('i-code') + 'API keys</h3>' +
      '<p class="muted">For scripts, agents and the CLI (<code>TACILYTICS_API_KEY</code>). A key acts as you, sees only your sites, and cannot touch the team or your security settings. Read-only unless you untick it.</p>' +
      '<div id="keyList"><p class="muted small">Loading…</p></div>' +
      '<div class="set-inline"><input id="keyName" type="text" placeholder="Name, e.g. reporting script" maxlength="60">' +
      (me.role !== 'viewer' ? '<label class="small muted" style="display:inline-flex;gap:6px;align-items:center;flex:0 0 auto"><input type="checkbox" id="keyRo" checked style="width:auto;margin:0"> read-only</label>' : '') +
      '<button class="btn" id="keyAdd">Create key</button></div><div id="keyOut"></div></div>' +
      '<div class="set-card"><h3>' + ico('i-shield') + 'Password</h3>' +
      '<div class="set-inline"><input id="pwOld" type="password" placeholder="Current password" autocomplete="current-password"><input id="pwNew" type="password" placeholder="New password (10+)" autocomplete="new-password"><button class="btn ghost" id="pwSave">Change</button></div>' +
      '<p class="muted small">Changing it signs you out on all other devices.</p></div>' +
      '<p class="muted small">Signed in as <strong>' + esc(me.username) + '</strong> · ' + ROLE_LABEL[me.role] + '</p>';

    bindPrefs();
    el.querySelectorAll('[data-delpk]').forEach(function (b) {
      b.onclick = function () { if (confirm('Remove this passkey?')) call('DELETE', '/api/me/passkeys/' + encodeURIComponent(b.dataset.delpk)).then(function () { openSettings('security'); }).catch(function (e) { setErr(e.message); }); };
    });
    if ($('pkAdd')) $('pkAdd').onclick = function () {
      setErr('');
      call('POST', '/api/me/passkeys/options').then(function (r) {
        return pkCreate(r.options).then(function (resp) { return call('POST', '/api/me/passkeys', { ticket: r.ticket, response: resp, name: $('pkName').value.trim() }); });
      }).then(function () { openSettings('security'); }).catch(function (e) { if (!pkCancelled(e)) setErr(e.message || 'Could not add the passkey'); });
    };
    if ($('totpStart')) $('totpStart').onclick = function () {
      call('POST', '/api/me/totp/setup').then(function (s) {
        $('totpSetup').innerHTML =
          '<div class="totp-qr"><img src="' + s.qr + '" alt="QR code for your authenticator app"></div>' +
          '<p class="muted small">Scan the code, or enter this key by hand:</p><div class="snippet center">' + esc(s.secret.replace(/(.{4})/g, '$1 ').trim()) + '</div>' +
          '<div class="set-inline"><input id="totpCode" type="text" inputmode="numeric" placeholder="6-digit code" autocomplete="one-time-code" maxlength="6"><button class="btn" id="totpOn">Turn on</button></div>';
        $('totpCode').focus();
        var on = function () {
          setErr('');
          call('POST', '/api/me/totp/enable', { code: $('totpCode').value.trim() }).then(function (r) { showRecovery(r.recoveryCodes); }).catch(function (e) { setErr(e.message); });
        };
        $('totpOn').onclick = on;
        $('totpCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') on(); });
      }).catch(function (e) { setErr(e.message); });
    };
    if ($('totpOff')) $('totpOff').onclick = function () {
      if (!confirm('Turn off two-factor codes?')) return;
      call('POST', '/api/me/totp/disable', { password: $('totpPw').value }).then(function () { openSettings('security'); }).catch(function (e) { setErr(e.message); });
    };
    if ($('newRecovery')) $('newRecovery').onclick = function () {
      call('POST', '/api/me/recovery', { password: $('totpPw').value }).then(function (r) { showRecovery(r.recoveryCodes); }).catch(function (e) { setErr(e.message); });
    };
    call('GET', '/api/me/report').then(function (r) {
      if (!r.configured) { $('repBox').innerHTML = '<p class="muted small">E-mail is not set up on this server yet (SMTP_URL and REPORT_FROM in .env).</p>'; return; }
      $('repBox').innerHTML = '<div class="set-inline"><input id="repMail" type="email" placeholder="you@example.com" value="' + esc(r.email || '') + '">' +
        '<label class="small muted" style="display:inline-flex;gap:6px;align-items:center;flex:0 0 auto"><input type="checkbox" id="repOn"' + (r.weekly ? ' checked' : '') + ' style="width:auto;margin:0"> every Monday</label>' +
        '<select id="repLang" style="flex:0 0 auto;width:auto" title="Language of the e-mail"><option value="en">English</option><option value="de">Deutsch</option></select>' +
        '<button class="btn ghost" id="repSave">Save</button><button class="btn ghost" id="repNow">Send one now</button></div>' +
        (r.last ? '<p class="muted small" style="margin:6px 0 0">Last sent ' + date(r.last) + '</p>' : '');
      $('repLang').value = r.lang || ((window.TaciLang && window.TaciLang.current) || 'en');
      $('repLang').setAttribute('data-no-i18n', '');
      $('repSave').onclick = function () {
        setErr('');
        call('POST', '/api/me/report', { email: $('repMail').value.trim(), weekly: $('repOn').checked, lang: $('repLang').value }).then(function () { $('repSave').textContent = 'Saved ✓'; }).catch(function (e) { setErr(e.message); });
      };
      $('repNow').onclick = function () {
        setErr(''); $('repNow').textContent = 'Sending…';
        call('POST', '/api/me/report', { email: $('repMail').value.trim(), weekly: $('repOn').checked, lang: $('repLang').value })
          .then(function () { return call('POST', '/api/me/report/send'); })
          .then(function () { $('repNow').textContent = 'Sent ✓'; })
          .catch(function (e) { $('repNow').textContent = 'Send one now'; setErr(e.message); });
      };
    }).catch(function () { $('repBox').innerHTML = ''; });
    function loadKeys() {
      call('GET', '/api/me/keys').then(function (keys) {
        $('keyList').innerHTML = keys.length ? keys.map(function (k) {
          return '<div class="set-row"><span>' + ico('i-code') + esc(k.name) + ' <code class="muted small">' + esc(k.prefix) + '…</code>' + (k.read_only ? ' <span class="pill">read-only</span>' : ' <span class="pill">read + write</span>') + '</span>' +
            '<span class="muted small">' + (k.last_used ? 'used ' + date(k.last_used) : 'never used') + '</span><button class="btn ghost danger mini" data-delkey="' + k.id + '">Revoke</button></div>';
        }).join('') : '<p class="muted small">No keys yet.</p>';
        $('keyList').querySelectorAll('[data-delkey]').forEach(function (b) {
          b.onclick = function () { if (confirm('Revoke this key? Scripts using it stop working immediately.')) call('DELETE', '/api/me/keys/' + b.dataset.delkey).then(loadKeys).catch(function (e) { setErr(e.message); }); };
        });
      }).catch(function (e) { setErr(e.message); });
    }
    loadKeys();
    $('keyAdd').onclick = function () {
      setErr('');
      call('POST', '/api/me/keys', { name: $('keyName').value.trim(), readOnly: $('keyRo') ? $('keyRo').checked : true }).then(function (k) {
        $('keyName').value = '';
        $('keyOut').innerHTML = '<p class="muted small" style="margin:10px 0 4px">Copy it now — it is shown only once.</p><div class="snippet">' + esc(k.key) + '</div><button class="btn ghost mini" id="keyCopy">Copy key</button>';
        $('keyCopy').onclick = function () { navigator.clipboard.writeText(k.key); this.textContent = 'Copied ✓'; };
        loadKeys();
      }).catch(function (e) { setErr(e.message); });
    };
    $('pwSave').onclick = function () {
      setErr('');
      call('POST', '/api/me/password', { password: $('pwOld').value, newPassword: $('pwNew').value }).then(function () {
        $('pwOld').value = ''; $('pwNew').value = ''; setErr(''); $('pwSave').textContent = 'Changed ✓';
      }).catch(function (e) { setErr(e.message); });
    };
  }
  function showRecovery(codes) {
    $('setSecurity').innerHTML =
      '<div class="set-card"><h3>' + ico('i-shield') + 'Save your recovery codes</h3>' +
      '<p class="muted">Each code works once, instead of a 6-digit code. Keep them somewhere safe — they are shown only now.</p>' +
      '<div class="snippet recovery">' + codes.map(esc).join('<br>') + '</div>' +
      '<div class="set-inline"><button class="btn ghost" id="dlRec">' + ico('i-download') + 'Download</button><button class="btn ghost" id="copyRec">Copy</button><button class="btn" id="recDone">I saved them</button></div></div>';
    $('copyRec').onclick = function () { navigator.clipboard.writeText(codes.join('\n')); $('copyRec').textContent = 'Copied ✓'; };
    $('dlRec').onclick = function () {
      // plain .txt, built in the browser; the codes never go to the server again
      var host = location.hostname;
      var text = 'Tacilytics recovery codes\n' +
        'Server: ' + location.origin + '\n' +
        'Account: ' + ((me && me.username) || '') + '\n' +
        'Created: ' + new Date().toISOString().slice(0, 10) + '\n\n' +
        'Each code works once, instead of a 6-digit code.\n\n' + codes.join('\n') + '\n';
      var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url; a.download = 'tacilytics-recovery-codes-' + host.replace(/[^a-z0-9.-]/gi, '_') + '.txt';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      $('dlRec').innerHTML = ico('i-check') + 'Downloaded';
    };
    $('recDone').onclick = function () { openSettings('security'); };
  }

  // team tab (owner)
  function siteNames(ids) {
    if (!ids) return 'all sites';
    var all = T().sites() || [];
    return ids.map(function (id) { var s = all.filter(function (x) { return x.id === id; })[0]; return s ? s.domain : '#' + id; }).join(', ');
  }
  function sitePicker(idPrefix, selected) {
    var all = T().sites() || [];
    return '<div class="site-pick" id="' + idPrefix + '">' + all.map(function (s) {
      var on = !selected || selected.indexOf(s.id) >= 0;
      return '<label><input type="checkbox" value="' + s.id + '"' + (on ? ' checked' : '') + '> ' + esc(s.domain) + '</label>';
    }).join('') + '</div>';
  }
  function pickedSites(idPrefix) {
    var box = $(idPrefix); if (!box) return null;
    var all = box.querySelectorAll('input'), ids = [];
    all.forEach(function (c) { if (c.checked) ids.push(Number(c.value)); });
    return ids.length === all.length ? null : ids; // everything ticked = all sites, also future ones
  }
  function renderTeam() {
    var el = $('setTeam');
    call('GET', '/api/team').then(function (t) {
      var rows = t.users.map(function (u) {
        var self = me && me.id === u.id;
        return '<div class="set-row team-row" data-uid="' + u.id + '">' +
          '<span><strong data-no-i18n>' + esc(u.username) + '</strong>' + (self ? ' <span class="muted small">(you)</span>' : '') +
          '<br><span class="muted small">' + (u.role === 'viewer' ? siteNames(u.sites) + ' · ' : '') + (u.totp ? '2FA on' : 'no 2FA') + (u.passkeys ? ' · ' + u.passkeys + ' passkey' + (u.passkeys > 1 ? 's' : '') : '') + ' · last sign-in ' + date(u.last_login) + '</span></span>' +
          '<select data-role>' + ['owner', 'admin', 'viewer'].map(function (r) { return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + ROLE_LABEL[r] + '</option>'; }).join('') + '</select>' +
          '<span class="row-actions">' + (u.role === 'viewer' ? '<button class="btn ghost mini" data-sites>Sites</button>' : '') +
          (!self ? '<button class="btn ghost mini" data-resetlink title="One-time link to set a new password (24 h)">Password link</button>' : '') +
          (u.totp && !self ? '<button class="btn ghost mini" data-reset2fa>Reset 2FA</button>' : '') +
          (!self ? '<button class="btn ghost danger mini" data-remove>Remove</button>' : '') + '</span></div>';
      }).join('');
      var invites = t.invites.map(function (i) {
        return '<div class="set-row"><span>' + ico('i-user-plus') + ROLE_LABEL[i.role] + (i.role === 'viewer' ? ' · ' + esc(siteNames(i.sites)) : '') + '</span><span class="muted small">expires ' + date(i.expires) + '</span><button class="btn ghost danger mini" data-delinv="' + i.id + '">Revoke</button></div>';
      }).join('');
      el.innerHTML =
        '<div class="set-card"><h3>' + ico('i-users') + 'Members</h3>' + rows + '</div>' +
        '<div class="set-card"><h3>' + ico('i-user-plus') + 'Invite someone</h3>' +
        '<p class="muted">Creates a link that works once, for 7 days. Send it yourself — Tacilytics sends no e-mail.</p>' +
        '<div class="set-inline"><select id="invRole">' + ['viewer', 'admin', 'owner'].map(function (r) { return '<option value="' + r + '">' + ROLE_LABEL[r] + ' — ' + ROLE_HELP[r] + '</option>'; }).join('') + '</select><button class="btn" id="invCreate">Create link</button></div>' +
        '<div id="invSites">' + sitePicker('invPick', null) + '</div>' +
        '<div id="invOut"></div>' + (invites ? '<h4 class="muted small" style="margin-top:12px">Open invites</h4>' + invites : '') + '</div>';

      $('invRole').onchange = function () { $('invSites').classList.toggle('hide', this.value !== 'viewer'); };
      $('invCreate').onclick = function () {
        setErr('');
        var role = $('invRole').value;
        call('POST', '/api/team/invites', { role: role, sites: role === 'viewer' ? pickedSites('invPick') : null }).then(function (r) {
          var url = location.origin + r.url;
          $('invOut').innerHTML = '<div class="snippet" id="invUrl">' + esc(url) + '</div><button class="btn ghost" id="invCopy">Copy link</button>';
          $('invCopy').onclick = function () { navigator.clipboard.writeText(url); $('invCopy').textContent = 'Copied ✓'; };
        }).catch(function (e) { setErr(e.message); });
      };
      el.querySelectorAll('[data-delinv]').forEach(function (b) {
        b.onclick = function () { call('DELETE', '/api/team/invites/' + b.dataset.delinv).then(renderTeam).catch(function (e) { setErr(e.message); }); };
      });
      el.querySelectorAll('.team-row').forEach(function (row) {
        var uid = row.dataset.uid;
        row.querySelector('[data-role]').onchange = function () {
          setErr('');
          call('PATCH', '/api/team/users/' + uid, { role: this.value }).then(renderTeam).catch(function (e) { setErr(e.message); renderTeam(); });
        };
        var rm = row.querySelector('[data-remove]');
        if (rm) rm.onclick = function () { if (confirm('Remove this member? They are signed out immediately.')) call('DELETE', '/api/team/users/' + uid).then(renderTeam).catch(function (e) { setErr(e.message); }); };
        var rl = row.querySelector('[data-resetlink]');
        if (rl) rl.onclick = function () {
          setErr('');
          call('POST', '/api/team/users/' + uid + '/reset-link').then(function (r) {
            var url = location.origin + r.url;
            var old = row.nextElementSibling; if (old && old.classList.contains('site-edit')) old.remove();
            var box = document.createElement('div'); box.className = 'site-edit';
            box.innerHTML = '<p class="muted small" style="margin:0 0 6px">Send this to ' + esc(r.username) + '. It works once, for 24 hours. Their 2FA stays on.</p><div class="snippet">' + esc(url) + '</div><button class="btn ghost mini" data-copy>Copy link</button>';
            row.after(box);
            box.querySelector('[data-copy]').onclick = function () { navigator.clipboard.writeText(url); this.textContent = 'Copied ✓'; };
          }).catch(function (e) { setErr(e.message); });
        };
        var r2 = row.querySelector('[data-reset2fa]');
        if (r2) r2.onclick = function () { if (confirm('Turn off 2FA for this member? Use this when they lost their phone.')) call('POST', '/api/team/users/' + uid + '/reset-2fa').then(renderTeam).catch(function (e) { setErr(e.message); }); };
        var st = row.querySelector('[data-sites]');
        if (st) st.onclick = function () {
          var u = t.users.filter(function (x) { return String(x.id) === uid; })[0];
          if (row.nextElementSibling && row.nextElementSibling.classList.contains('site-edit')) { row.nextElementSibling.remove(); return; }
          var box = document.createElement('div'); box.className = 'site-edit';
          box.innerHTML = sitePicker('pick' + uid, u.sites) + '<button class="btn mini" data-savesites>Save</button>';
          row.after(box);
          box.querySelector('[data-savesites]').onclick = function () {
            call('PATCH', '/api/team/users/' + uid, { sites: pickedSites('pick' + uid) }).then(renderTeam).catch(function (e) { setErr(e.message); });
          };
        };
      });
    }).catch(function (e) { setErr(e.message); });
  }

  // activity (audit log, owner)
  var ACTION_LABEL = {
    'site.add': 'added site', 'site.remove': 'removed site', 'share.add': 'created share link', 'share.revoke': 'revoked share link',
    'note.add': 'added note', 'note.remove': 'removed note', 'funnel.add': 'added funnel', 'funnel.remove': 'removed funnel',
    'team.first-owner': 'created the first account', 'team.invite': 'created invite', 'team.invite.revoke': 'revoked invite',
    'team.join': 'joined via invite', 'team.change': 'changed role', 'team.remove': 'removed member', 'team.2fa.reset': 'reset 2FA of',
    'team.reset-link': 'created password link for', 'me.password': 'changed own password', 'me.password.reset-link': 'set a new password via link',
    'me.2fa.on': 'turned 2FA on', 'me.2fa.off': 'turned 2FA off', 'me.recovery.new': 'made new recovery codes',
    'cli.reset': 'reset the login (password, 2FA, sessions) of', 'me.report.on': 'turned the weekly report on', 'me.report.off': 'turned the weekly report off',
    'alert.add': 'added alert', 'alert.remove': 'removed alert', 'alert.on': 'turned alert on', 'alert.off': 'turned alert off',
    'me.passkey.add': 'added passkey', 'me.passkey.remove': 'removed passkey', 'me.apikey.add': 'created API key', 'me.apikey.revoke': 'revoked API key',
  };
  function renderActivity(before, append) {
    var el = $('setActivity');
    call('GET', '/api/audit?limit=60' + (before ? '&before=' + before : '')).then(function (rows) {
      var html = rows.map(function (e) {
        var when = new Date(e.ts);
        return '<div class="set-row act-row"><span class="muted small act-time" title="' + esc(when.toISOString()) + '">' +
          esc(when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) + '</span>' +
          '<span><strong' + (e.actor && e.actor !== 'API key' && e.actor !== 'passphrase' ? ' data-no-i18n' : '') + '>' + esc(e.actor || 'someone') + '</strong> ' + esc(ACTION_LABEL[e.action] || e.action) + (e.target ? ' <span class="act-target">' + esc(e.target) + '</span>' : '') + '</span>' +
          '<span class="muted small act-ip">' + esc(e.ip || '') + '</span></div>';
      }).join('');
      if (!append) el.innerHTML = '<div class="set-card"><h3>' + ico('i-timer') + 'Activity</h3><p class="muted">Every change by anyone on the team, newest first. Kept for a year (AUDIT_RETENTION_DAYS).</p><div id="actRows"></div><div id="actMore"></div></div>';
      $('actRows').insertAdjacentHTML('beforeend', html || (append ? '' : '<p class="muted small">Nothing yet.</p>'));
      $('actMore').innerHTML = rows.length === 60 ? '<button class="btn ghost mini" id="actMoreBtn">Older</button>' : '';
      if (rows.length === 60) $('actMoreBtn').onclick = function () { renderActivity(rows[rows.length - 1].ts, true); };
    }).catch(function (e) { setErr(e.message); });
  }

  window.TaciAccount = { prepareLogin: prepareLogin, showInvite: showInvite, showReset: showReset, afterBoot: afterBoot };

  // ── closing modals: ONE function for every exit (X, Close button, Esc, click on the backdrop) ──
  // login / reset / invite are not closable — there is nothing behind them without signing in.
  var LOCKED = { login: 1, reset: 1, invite: 1 };
  function closeModal(ov) {
    if (!ov || LOCKED[ov.id] || ov.classList.contains('hide')) return;
    ov.classList.add('hide');
    ov.dispatchEvent(new CustomEvent('taci:close')); // e.g. the live view stops polling
  }
  function topModal() {
    var open = [].filter.call(document.querySelectorAll('.modal-overlay'), function (o) { return !o.classList.contains('hide'); });
    // a locked one (e.g. login after the session expired) wins even though it sits first in the DOM —
    // otherwise Esc would close the settings BEHIND the login
    var locked = open.filter(function (o) { return LOCKED[o.id]; })[0];
    return locked || open[open.length - 1] || null; // later in the DOM = drawn on top
  }
  document.addEventListener('click', function (e) {
    var x = e.target.closest && e.target.closest('[data-close]');
    if (x) closeModal(x.closest('.modal-overlay'));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    var top = topModal();
    if (top && !LOCKED[top.id]) { e.preventDefault(); closeModal(top); }
  });
  // backdrop: press AND release on the overlay itself — selecting text inside and letting go outside must not close
  var downOn = null;
  document.addEventListener('mousedown', function (e) { downOn = e.target; });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('modal-overlay') && downOn === t && topModal() === t) closeModal(t);
  });
  window.TaciModal = { close: closeModal };
})();
