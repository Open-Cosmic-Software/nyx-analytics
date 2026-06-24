/* Nyx Analytics dashboard 🦞 */
(function () {
  var TOKEN = localStorage.getItem('nyx_token') || '';
  var state = { site: localStorage.getItem('nyx_site') || '', period: '7d', sites: [] };
  var $ = function (id) { return document.getElementById(id); };
  var ORIGIN = location.origin;

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json', 'x-session-token': TOKEN }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { showLogin(); throw new Error('auth'); }
      return r.json().catch(function () { return {}; });
    });
  }

  // ── flags / names ──
  function flag(cc) {
    if (!cc || cc.length !== 2) return '🏳️';
    return cc.toUpperCase().replace(/./g, function (c) { return String.fromCodePoint(127397 + c.charCodeAt(0)); });
  }
  var NAMES = { DE: 'Germany', AT: 'Austria', CH: 'Switzerland', GB: 'United Kingdom', US: 'United States', FR: 'France', NL: 'Netherlands', ES: 'Spain', IT: 'Italy', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland', CZ: 'Czechia', BE: 'Belgium', IE: 'Ireland', PT: 'Portugal', CA: 'Canada', AU: 'Australia', BR: 'Brazil', IN: 'India', JP: 'Japan', CN: 'China', RU: 'Russia', TR: 'Turkey', MX: 'Mexico', HU: 'Hungary', RO: 'Romania', GR: 'Greece', UA: 'Ukraine', HR: 'Croatia', NZ: 'New Zealand', SG: 'Singapore', KR: 'South Korea', IL: 'Israel', AE: 'UAE', ZA: 'South Africa' };

  // ── login ──
  function showLogin() { $('login').classList.remove('hide'); $('app').classList.add('hide'); }
  function hideLogin() { $('login').classList.add('hide'); $('app').classList.remove('hide'); }
  function login() {
    var pw = $('pw').value;
    fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { $('loginErr').textContent = res.j.error || 'Wrong password'; return; }
        TOKEN = res.j.token; localStorage.setItem('nyx_token', TOKEN); $('loginErr').textContent = '';
        boot();
      })
      .catch(function () { $('loginErr').textContent = 'Connection error'; });
  }
  $('loginBtn').onclick = login;
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
  $('logoutBtn').onclick = function () { localStorage.removeItem('nyx_token'); TOKEN = ''; showLogin(); };

  // ── sites ──
  function loadSites() {
    return api('/api/sites').then(function (sites) {
      state.sites = sites;
      var sel = $('siteSelect');
      sel.innerHTML = sites.map(function (s) { return '<option value="' + s.domain + '">' + s.domain + '</option>'; }).join('');
      if (!sites.length) { sel.innerHTML = '<option>no sites yet</option>'; return; }
      if (!state.site || !sites.some(function (s) { return s.domain === state.site; })) state.site = sites[0].domain;
      sel.value = state.site;
    });
  }
  $('siteSelect').onchange = function () { state.site = this.value; localStorage.setItem('nyx_site', state.site); load(); };

  $('addSiteBtn').onclick = function () { $('addModal').classList.remove('hide'); $('newDomain').value = ''; $('addErr').textContent = ''; $('newDomain').focus(); };
  $('cancelAdd').onclick = function () { $('addModal').classList.add('hide'); };
  $('createSiteBtn').onclick = function () {
    var d = $('newDomain').value.trim();
    api('/api/sites', { method: 'POST', body: JSON.stringify({ domain: d }) }).then(function (s) {
      if (s.error) { $('addErr').textContent = s.error; return; }
      $('addModal').classList.add('hide');
      state.site = s.domain; localStorage.setItem('nyx_site', state.site);
      loadSites().then(function () { $('siteSelect').value = state.site; load(); showSnippet(s.domain); });
    });
  };
  $('newDomain').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('createSiteBtn').click(); });

  // ── snippet ──
  function snippetFor(domain) {
    return '<script defer data-domain="' + domain + '" src="' + ORIGIN + '/nyx.js"><\/script>';
  }
  function showSnippet(domain) {
    $('snipDomain').textContent = domain;
    $('snippetCode').textContent = snippetFor(domain);
    $('snippetModal').classList.remove('hide');
  }
  $('snippetBtn').onclick = function () { if (state.site) showSnippet(state.site); };
  $('closeSnippet').onclick = function () { $('snippetModal').classList.add('hide'); };
  $('copySnippet').onclick = function () {
    navigator.clipboard.writeText(snippetFor($('snipDomain').textContent)).then(function () {
      $('copySnippet').textContent = 'Copied ✓'; setTimeout(function () { $('copySnippet').textContent = 'Copy snippet'; }, 1500);
    });
  };

  // ── periods ──
  Array.prototype.forEach.call(document.querySelectorAll('#periods button'), function (b) {
    b.onclick = function () {
      document.querySelectorAll('#periods button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active'); state.period = b.dataset.p; load();
    };
  });

  // ── rendering ──
  function fmt(n) { n = n || 0; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'; return String(n); }

  function bars(elId, rows, opts) {
    opts = opts || {};
    var el = $(elId);
    if (!rows || !rows.length) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.visitors || 0; })) || 1;
    el.innerHTML = rows.map(function (r) {
      var label = opts.label ? opts.label(r) : (r.name || '—');
      var w = Math.max(3, Math.round(((r.visitors || 0) / max) * 100));
      return '<div class="bar"><div class="fill" style="width:' + w + '%"></div>' +
        '<span class="name">' + label + '</span><span class="val">' + fmt(r.visitors) + '</span></div>';
    }).join('');
  }

  function drawChart(series) {
    var svg = $('chart'); var W = 800, H = 220, pad = 8;
    var max = Math.max(1, Math.max.apply(null, series.map(function (d) { return Math.max(d.pageviews, d.visitors); })));
    var n = series.length;
    var x = function (i) { return pad + (i * (W - 2 * pad)) / Math.max(1, n - 1); };
    var y = function (v) { return H - pad - (v / max) * (H - 2 * pad); };
    function path(key) {
      return series.map(function (d, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(d[key]).toFixed(1); }).join(' ');
    }
    var areaP = path('visitors') + ' L' + x(n - 1).toFixed(1) + ' ' + (H - pad) + ' L' + x(0).toFixed(1) + ' ' + (H - pad) + ' Z';
    var hovers = series.map(function (d, i) {
      var w = (W - 2 * pad) / Math.max(1, n);
      return '<rect x="' + (x(i) - w / 2).toFixed(1) + '" y="0" width="' + w.toFixed(1) + '" height="' + H + '" fill="transparent" ' +
        'data-i="' + i + '"></rect>';
    }).join('');
    svg.innerHTML =
      '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#e879a8" stop-opacity="0.35"/><stop offset="100%" stop-color="#e879a8" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path d="' + areaP + '" fill="url(#ag)"/>' +
      '<path d="' + path('pageviews') + '" fill="none" stroke="#67e8f9" stroke-width="2" opacity="0.85"/>' +
      '<path d="' + path('visitors') + '" fill="none" stroke="#e879a8" stroke-width="2.5"/>' +
      series.map(function (d, i) { return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(d.visitors).toFixed(1) + '" r="2.5" fill="#e879a8"/>'; }).join('') +
      hovers;
    var tip = $('tip');
    Array.prototype.forEach.call(svg.querySelectorAll('rect'), function (rect) {
      rect.addEventListener('mousemove', function (e) {
        var d = series[+rect.dataset.i];
        tip.innerHTML = '<strong>' + d.label + '</strong><br>🦞 ' + d.visitors + ' visitors<br>📄 ' + d.pageviews + ' views';
        tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY - 10) + 'px'; tip.style.opacity = 1;
      });
      rect.addEventListener('mouseleave', function () { tip.style.opacity = 0; });
    });
  }

  function load() {
    if (!state.site || state.site === 'no sites yet') {
      ['s-visitors', 's-pageviews', 's-bounce', 's-vpv'].forEach(function (id) { $(id).textContent = '—'; });
      ['p-pages', 'p-sources', 'p-countries', 'p-browsers', 'p-os', 'p-devices'].forEach(function (id) { $(id).innerHTML = '<div class="empty">Add a site to begin</div>'; });
      $('chart').innerHTML = '';
      return;
    }
    api('/api/stats?site=' + encodeURIComponent(state.site) + '&period=' + state.period).then(function (s) {
      if (s.error) return;
      $('s-visitors').textContent = fmt(s.totals.visitors);
      $('s-pageviews').textContent = fmt(s.totals.pageviews);
      $('s-bounce').textContent = s.totals.bounce + '%';
      $('s-vpv').textContent = s.totals.viewsPerVisitor;
      $('realtime').textContent = s.realtime;
      drawChart(s.series);
      bars('p-pages', s.pages, { label: function (r) { return r.name; } });
      bars('p-sources', s.sources, { label: function (r) { return r.name === 'Direct' ? '➜ Direct / none' : r.name; } });
      bars('p-countries', s.countries, { label: function (r) { return flag(r.name) + ' ' + (NAMES[r.name] || r.name); } });
      bars('p-browsers', s.browsers);
      bars('p-os', s.os);
      bars('p-devices', s.devices);
    });
  }

  function boot() {
    hideLogin();
    loadSites().then(load);
    clearInterval(window.__rt);
    window.__rt = setInterval(function () {
      if (!state.site || document.hidden) return;
      api('/api/stats?site=' + encodeURIComponent(state.site) + '&period=' + state.period).then(function (s) {
        if (s && s.realtime != null) $('realtime').textContent = s.realtime;
      }).catch(function () {});
    }, 15000);
  }

  if (TOKEN) boot(); else showLogin();
})();
