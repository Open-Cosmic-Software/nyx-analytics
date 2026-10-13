/* Nyx Analytics dashboard 🦞 */
(function () {
  var TOKEN = localStorage.getItem('nyx_token') || '';
  // share mode: /share/<token> renders a read-only dashboard without login
  var SHARE = (location.pathname.match(/^\/share\/([a-f0-9]{32,64})$/) || [])[1] || '';
  var state = { site: localStorage.getItem('nyx_site') || '', period: '7d', from: '', to: '', sites: [], filters: {}, srcTab: 'sources', pageTab: 'pages' };
  // which chart series are visible (toggled via the legend)
  state.show = { visitors: true, pageviews: true };
  try {
    var savedShow = JSON.parse(localStorage.getItem('nyx_show') || 'null');
    // Never allow both off — an empty chart looks like broken data, not like a choice.
    if (savedShow && (savedShow.visitors || savedShow.pageviews)) {
      state.show = { visitors: !!savedShow.visitors, pageviews: !!savedShow.pageviews };
    }
  } catch (e) { /* corrupt value → keep both visible */ }
  var lastStats = null;
  // dashboard segmentation filters (whitelist mirrors the server's FILTER_COLS + goal)
  var FILTER_LABELS = { country: 'Country', source: 'Source', page: 'Page', browser: 'Browser', os: 'OS', device: 'Device', lang: 'Language', medium: 'Medium', campaign: 'Campaign', platform: 'Platform', version: 'App version', goal: 'Goal' };

  // build the stats/realtime query string from the current site, period/range and active filters
  function statsQuery() {
    var q = 'site=' + encodeURIComponent(state.site);
    if (SHARE) q += '&share=' + SHARE;
    if (state.from && state.to) q += '&from=' + state.from + '&to=' + state.to;
    else q += '&period=' + state.period;
    Object.keys(state.filters).forEach(function (k) { q += '&' + k + '=' + encodeURIComponent(state.filters[k]); });
    return q;
  }
  function setFilter(key, value) { if (!value || value === 'Direct') return; state.filters[key] = value; load(); }
  function removeFilter(key) { delete state.filters[key]; load(); }
  function clearFilters() { state.filters = {}; load(); }
  var $ = function (id) { return document.getElementById(id); };
  var ORIGIN = location.origin;
  // Escape any value that originates from visitor beacons before it touches innerHTML.
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json', 'x-session-token': TOKEN }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { if (!SHARE) showLogin(); throw new Error('auth'); }
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
      sel.innerHTML = sites.map(function (s) { return '<option value="' + esc(s.domain) + '">' + esc(s.domain) + '</option>'; }).join('');
      if (!sites.length) { sel.innerHTML = '<option>no sites yet</option>'; return; }
      if (!state.site || !sites.some(function (s) { return s.domain === state.site; })) state.site = sites[0].domain;
      sel.value = state.site;
    });
  }
  $('siteSelect').onchange = function () { state.site = this.value; localStorage.setItem('nyx_site', state.site); load(); if (typeof loadFunnels === 'function') loadFunnels(); };

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

  // ── snippet: website, Flutter app, any other app (same site, platform tells them apart) ──
  var SNIP_REPO = 'https://github.com/Open-Cosmic-Software/nyx-analytics';
  state.snipTab = 'web';
  function snippetFor(domain) {
    return '<script defer data-domain="' + domain + '" src="' + ORIGIN + '/nyx.js"><\/script>';
  }
  function snipParts(domain, tab) {
    if (tab === 'flutter') return {
      s1: '1 · Add the package to <code>pubspec.yaml</code>, then run <code>flutter pub get</code>:',
      c1: 'dependencies:\n  nyx_analytics:\n    git:\n      url: ' + SNIP_REPO + '\n      path: sdk/flutter',
      s2: '2 · Start it in <code>main()</code> — screens are tracked automatically:',
      c2: "import 'package:nyx_analytics/nyx_analytics.dart';\n\nvoid main() {\n  NyxAnalytics.init(\n    endpoint: '" + ORIGIN + "',\n    domain: '" + domain + "',\n    appVersion: '1.0.0',\n    enabled: true,\n  );\n  runApp(MaterialApp(\n    navigatorObservers: [NyxRouteObserver()],\n    home: const MyHome(),\n  ));\n}",
      hint: 'Goals &amp; revenue anywhere in your code:<br><code>NyxAnalytics.instance.event(\'Signup\')</code> · <code>.search(\'term\', 6)</code> · <code>.purchase(value: 49.90)</code><br><span style="opacity:.7">No cookies, no device id. Want it only after consent? Leave out <code>enabled: true</code> and call <code>setEnabled(true)</code> later.</span>'
    };
    if (tab === 'other') return {
      s1: 'Swift, Kotlin, React Native, Unity … — send one JSON <code>POST</code> per screen or event:',
      c1: 'POST ' + ORIGIN + '/api/collect\nContent-Type: application/json\nUser-Agent: MyApp/1.0 (android)\n\n{\n  "d": "' + domain + '",\n  "p": "/product/42",\n  "pf": "android",\n  "sid": "<random id, new per app launch>",\n  "av": "1.0.0"\n}',
      s2: 'Event with properties (e.g. a purchase) — add a name and props:',
      c2: '{\n  "d": "' + domain + '", "p": "/checkout", "pf": "ios", "sid": "…",\n  "n": "Purchase",\n  "pr": { "value": "49.90", "currency": "EUR" }\n}',
      hint: '<code>pf</code>: android · ios · macos · windows · linux. <code>sid</code>: 16–64 random chars, kept in memory only — never a device id. All fields: <a href="' + SNIP_REPO + '#mobile--desktop-apps" target="_blank" rel="noopener">README</a>.'
    };
    return {
      s1: 'Paste this once into the <code>&lt;head&gt;</code> of your site:',
      c1: snippetFor(domain), s2: '', c2: '',
      hint: 'Track goals &amp; properties from your code:<br><code>nyx(\'Signup\')</code> · <code>nyx(\'Signup\', { plan: \'pro\' })</code><br><span style="opacity:.7">Privacy flags on the tag: <code>data-honor-dnt</code> · <code>data-track-outbound</code></span>'
    };
  }
  function renderSnippet() {
    var d = $('snipDomain').textContent, p = snipParts(d, state.snipTab);
    $('snipStep1').innerHTML = p.s1;
    $('snippetCode').textContent = p.c1;
    $('snipStep2').innerHTML = p.s2;
    $('snippetCode2').textContent = p.c2;
    $('snippetCode2').classList.toggle('hide', !p.c2);
    $('copySnippet2').classList.toggle('hide', !p.c2);
    $('copySnippet').textContent = p.c2 ? 'Copy step 1' : 'Copy';
    $('snipHint').innerHTML = p.hint;
  }
  function showSnippet(domain) {
    $('snipDomain').textContent = domain;
    renderSnippet();
    $('snippetModal').classList.remove('hide');
  }
  function copyFrom(btnId, codeId, label) {
    navigator.clipboard.writeText($(codeId).textContent).then(function () {
      $(btnId).textContent = 'Copied ✓'; setTimeout(function () { renderSnippet(); if (label) $(btnId).textContent = label; }, 1500);
    });
  }
  // ── CSV export of the current view ──
  $('exportBtn').onclick = function () {
    if (!lastStats) return;
    var s = lastStats, rows = [['metric', 'name', 'visitors', 'pageviews']];
    rows.push(['summary', 'visitors', s.totals.visitors, '']);
    rows.push(['summary', 'pageviews', '', s.totals.pageviews]);
    rows.push(['summary', 'bounce_rate', s.totals.bounce + '%', '']);
    rows.push(['summary', 'avg_visit_seconds', s.totals.duration == null ? '' : s.totals.duration, '']);
    [['page', s.pages], ['entry_page', s.entryPages], ['exit_page', s.exitPages], ['source', s.sources], ['medium', s.mediums], ['campaign', s.campaigns], ['country', s.countries], ['browser', s.browsers], ['os', s.os], ['device', s.devices], ['language', s.languages], ['goal', s.goals]].forEach(function (pair) {
      (pair[1] || []).forEach(function (r) { rows.push([pair[0], r.name, r.visitors, r.pageviews]); });
    });
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nyx-' + state.site + '-' + state.period + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $('snippetBtn').onclick = function () { if (state.site) showSnippet(state.site); };
  $('closeSnippet').onclick = function () { $('snippetModal').classList.add('hide'); };
  $('copySnippet').onclick = function () { copyFrom('copySnippet', 'snippetCode'); };
  $('copySnippet2').onclick = function () { copyFrom('copySnippet2', 'snippetCode2', 'Copy step 2'); };

  // ── live visitors (last 30 min) ──
  var liveTimer = null;
  function openLive() { if (!state.site || state.site === 'no sites yet') return; $('liveModal').classList.remove('hide'); fetchLive(); clearInterval(liveTimer); liveTimer = setInterval(fetchLive, 8000); }
  function closeLive() { $('liveModal').classList.add('hide'); clearInterval(liveTimer); liveTimer = null; }
  function fetchLive() {
    if (document.hidden) return;
    api('/api/realtime?site=' + encodeURIComponent(state.site)).then(function (r) {
      if (r.error) return;
      $('live-online').textContent = r.online;
      renderSpark(r.minutes);
      renderFeed(r.recent, r.now);
    }).catch(function () {});
  }
  function renderSpark(minutes) {
    var svg = $('live-spark'), W = 600, H = 70, n = minutes.length;
    var max = Math.max.apply(null, minutes.map(function (m) { return m.pageviews; }).concat([1]));
    var bw = W / n;
    svg.innerHTML = minutes.map(function (m, i) {
      var h = m.pageviews ? Math.max(3, Math.round((m.pageviews / max) * (H - 6))) : 0;
      return '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + (H - h) + '" width="' + (bw - 2).toFixed(1) + '" height="' + h + '" rx="2" fill="' + (i >= n - 5 ? '#e879a8' : 'rgba(168,85,247,.5)') + '"></rect>';
    }).join('');
  }
  function timeAgo(ts, now) {
    var s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 8) return 'just now';
    if (s < 60) return s + 's ago';
    return Math.round(s / 60) + 'm ago';
  }
  function renderFeed(recent, now) {
    var el = $('live-feed');
    if (!recent || !recent.length) { el.innerHTML = '<div class="empty">No visitors in the last 30 minutes</div>'; return; }
    el.innerHTML = recent.map(function (e) {
      var loc = e.country ? flag(e.country) : '🌐';
      var what = e.name ? '<span class="goal">🎯 ' + esc(e.name) + '</span>' : '<span class="path">' + esc(e.path) + '</span>';
      var src = (e.source && e.source !== 'Direct') ? '↗ ' + e.source : '';
      var meta = [e.platform ? platformLabel(e.platform) : e.browser, e.device, src].filter(Boolean).map(esc).join(' · ');
      return '<div class="feed-row"><span class="fl" title="' + esc(e.country || e.tz || '') + '">' + loc + '</span>' +
        '<div class="fw">' + what + '<span class="fm">' + meta + '</span></div>' +
        '<span class="ft">' + timeAgo(e.ts, now) + '</span></div>';
    }).join('');
  }
  $('realtimeBtn').onclick = openLive;
  $('closeLive').onclick = closeLive;

  // ── periods ──
  Array.prototype.forEach.call(document.querySelectorAll('#periods button'), function (b) {
    b.onclick = function () {
      document.querySelectorAll('#periods button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active'); state.period = b.dataset.p;
      state.from = ''; state.to = ''; $('fromDate').value = ''; $('toDate').value = ''; // clear custom range
      load();
    };
  });

  // ── custom date range ──
  $('applyRange').onclick = function () {
    var f = $('fromDate').value, t = $('toDate').value;
    if (!f || !t) return;
    if (f > t) { var tmp = f; f = t; t = tmp; $('fromDate').value = f; $('toDate').value = t; }
    state.from = f; state.to = t;
    document.querySelectorAll('#periods button').forEach(function (x) { x.classList.remove('active'); });
    load();
  };

  // ── panel tabs (Pages + Sources) ──
  function wireTabs(id, key, rerender) {
    Array.prototype.forEach.call(document.querySelectorAll('#' + id + ' button'), function (b) {
      b.onclick = function () {
        document.querySelectorAll('#' + id + ' button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active'); state[key] = b.dataset.t; rerender();
      };
    });
  }
  wireTabs('pageTabs', 'pageTab', renderPagesPanel);
  wireTabs('srcTabs', 'srcTab', renderSourcesPanel);
  wireTabs('searchTabs', 'searchTab', function () { renderSearch(); });
  wireTabs('pfTabs', 'pfTab', function () { renderPlatformsPanel(); });
  wireTabs('snipTabs', 'snipTab', renderSnippet);

  // ── rendering ──
  function fmt(n) { n = n || 0; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'; return String(n); }
  function trend(id, p) {
    var el = $(id);
    if (p == null) { el.textContent = ''; el.className = 'trend'; return; }
    var up = p >= 0;
    el.textContent = (up ? '▲ ' : '▼ ') + Math.abs(p) + '%';
    el.className = 'trend ' + (up ? 'up' : 'down');
  }

  function bars(elId, rows, opts) {
    opts = opts || {};
    var el = $(elId);
    if (!rows || !rows.length) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.visitors || 0; })) || 1;
    var fk = opts.filterKey; // when set, clicking a row drills into that segment
    el.innerHTML = rows.map(function (r) {
      var label = opts.label ? opts.label(r) : (r.name || '—');
      var w = Math.max(3, Math.round(((r.visitors || 0) / max) * 100));
      var val = opts.value ? opts.value(r) : r.name;
      var clickable = fk && val && val !== 'Direct';
      var cr = opts.cr && r.cr != null ? '<span class="cr">' + r.cr + '%</span>' : '';
      return '<div class="bar' + (clickable ? ' clickable' : '') + '"' + (clickable ? ' data-fk="' + esc(fk) + '" data-fv="' + esc(val) + '"' : '') + ' title="' + esc(label) + '">' +
        '<div class="fill" style="width:' + w + '%"></div>' +
        '<span class="name">' + esc(label) + '</span><span class="val">' + fmt(r.visitors) + cr + '</span></div>';
    }).join('');
    if (fk) Array.prototype.forEach.call(el.querySelectorAll('.bar.clickable'), function (b) {
      b.onclick = function () { setFilter(b.getAttribute('data-fk'), b.getAttribute('data-fv')); };
    });
  }

  // seconds → "1m 23s" / "45s"
  function fmtDur(s) {
    if (s == null) return '—';
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), r = s % 60;
    return m + 'm' + (r ? ' ' + r + 's' : '');
  }

  // ── segmentation filter chips ──
  function renderFilters() {
    var el = $('filters');
    var keys = Object.keys(state.filters);
    if (!keys.length) { el.classList.add('hide'); el.innerHTML = ''; return; }
    el.classList.remove('hide');
    var chips = keys.map(function (k) {
      var v = state.filters[k];
      var disp = k === 'country' ? (flag(v) + ' ' + (NAMES[v] || v)) : v;
      return '<span class="chip"><span class="k">' + esc(FILTER_LABELS[k] || k) + '</span>' + esc(disp) +
        '<button data-rm="' + esc(k) + '" title="Remove">✕</button></span>';
    }).join('');
    el.innerHTML = '<span class="flabel">Filtered by</span>' + chips + '<span class="chip clear" id="clearFilters">Clear all</span>';
    Array.prototype.forEach.call(el.querySelectorAll('[data-rm]'), function (b) { b.onclick = function () { removeFilter(b.getAttribute('data-rm')); }; });
    var ce = $('clearFilters'); if (ce) ce.onclick = clearFilters;
  }

  function drawChart(series) {
    var svg = $('chart'); var W = 800, H = 220, pad = 8;
    var showV = state.show.visitors, showP = state.show.pageviews;
    // Only visible series define the scale — otherwise hiding a line would not zoom in.
    var max = Math.max(1, Math.max.apply(null, series.map(function (d) {
      return Math.max(showV ? d.visitors : 0, showP ? d.pageviews : 0);
    })));
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
      (showV ? '<path d="' + areaP + '" fill="url(#ag)"/>' : '') +
      (showP ? '<path d="' + path('pageviews') + '" fill="none" stroke="#67e8f9" stroke-width="2" opacity="0.85"/>' : '') +
      (showV ? '<path d="' + path('visitors') + '" fill="none" stroke="#e879a8" stroke-width="2.5"/>' : '') +
      (showV ? series.map(function (d, i) { return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(d.visitors).toFixed(1) + '" r="2.5" fill="#e879a8"/>'; }).join('') : '') +
      hovers;
    var tip = $('tip');
    Array.prototype.forEach.call(svg.querySelectorAll('rect'), function (rect) {
      rect.addEventListener('mousemove', function (e) {
        var d = series[+rect.dataset.i];
        tip.innerHTML = '<strong>' + esc(d.label) + '</strong>' +
          (showV ? '<br>🦞 ' + d.visitors + ' visitors' : '') +
          (showP ? '<br>📄 ' + d.pageviews + ' views' : '');
        tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY - 10) + 'px'; tip.style.opacity = 1;
      });
      rect.addEventListener('mouseleave', function () { tip.style.opacity = 0; });
    });
  }

  // ── tab-aware panels (Pages: Top/Entry/Exit · Sources: Source/Medium/Campaign) ──
  function renderPagesPanel() {
    var s = lastStats; if (!s) return;
    bars('p-pages', s[state.pageTab] || s.pages, { filterKey: 'page', label: function (r) { return r.name; } });
  }
  // readable names for app/short referrers — the raw host stays in the data and the tooltip
  var SOURCE_NAMES = {
    'com.google.android.googlequicksearchbox': 'Google App (Android)', 'com.google.android.gm': 'Gmail App',
    'fb': 'Facebook', 'm.facebook.com': 'Facebook (mobile)', 'l.facebook.com': 'Facebook', 'lm.facebook.com': 'Facebook',
    'ig': 'Instagram', 'l.instagram.com': 'Instagram', 'homescreen': 'Homescreen (app shortcut)',
    'android-app://com.google.android.googlequicksearchbox': 'Google App (Android)', 't.co': 'X / Twitter',
  };
  var PLATFORM_NAMES = { web: '🌐 Web', android: '🤖 Android app', ios: '🍏 iOS app', macos: '💻 macOS app', windows: '🪟 Windows app', linux: '🐧 Linux app' };
  function platformLabel(n) { return PLATFORM_NAMES[n] || n; }
  state.pfTab = 'platforms';
  function renderPlatformsPanel() {
    var s = lastStats; if (!s) return;
    var w = $('w-platforms');
    // only interesting once an app reports — a site that is web-only keeps its old layout
    var hasApp = (s.platforms || []).some(function (r) { return r.name !== 'web'; }) || state.filters.platform;
    if (!hasApp) { w.classList.add('hide'); return; }
    w.classList.remove('hide');
    if (state.pfTab === 'appVersions') bars('p-platforms', s.appVersions || [], { filterKey: 'version', label: function (r) { return 'v' + r.name; } });
    else bars('p-platforms', s.platforms || [], { filterKey: 'platform', label: function (r) { return platformLabel(r.name); } });
  }
  function sourceLabel(n) { if (n === 'Direct') return '➜ Direct / none'; var nice = SOURCE_NAMES[n]; return nice ? nice + ' · ' + n : n; }
  function renderSourcesPanel() {
    var s = lastStats; if (!s) return;
    var tab = state.srcTab, fk = tab === 'mediums' ? 'medium' : tab === 'campaigns' ? 'campaign' : 'source';
    bars('p-sources', s[tab] || [], { filterKey: fk, label: function (r) { return tab === 'sources' ? sourceLabel(r.name) : r.name; } });
    var el = $('p-sources');
    if (tab === 'sources' && s.paymentReturns && s.paymentReturns.length) {
      var n = s.paymentReturns.reduce(function (a, r) { return a + (r.visitors || 0); }, 0);
      var who = s.paymentReturns.map(function (r) { return r.name; }).join(', ');
      el.insertAdjacentHTML('beforeend', '<p class="pay-note" title="' + esc(who) + '">💳 ' + fmt(n) + ' returning from payment (' + esc(who) + ') — not counted as a source</p>');
    }
  }

  function money(v, cur) {
    try { return new Intl.NumberFormat(navigator.language || 'de-DE', { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v); }
    catch (e) { return (Math.round(v * 100) / 100) + ' ' + (cur || ''); }
  }
  function pctTxt(p) { return p == null ? '—' : (p >= 0 ? '▲ ' : '▼ ') + Math.abs(p) + '%'; }
  function pctCls(p) { return p == null ? '' : (p >= 0 ? 'up' : 'down'); }

  // previous-period trend already sits in the stat cards; last year only appears once data reaches back that far
  function renderCompare(s) {
    ['visitors', 'pageviews'].forEach(function (k) {
      var el = $('y-' + k); if (!el) return;
      if (!s.yoy || s.yoy[k] == null) { el.classList.add('hide'); el.textContent = ''; return; }
      el.classList.remove('hide');
      el.className = 'yoy ' + pctCls(s.yoy[k]);
      el.textContent = pctTxt(s.yoy[k]) + ' vs last year';
    });
  }

  function renderInsights(s) {
    renderCompare(s);
    // commerce cards + revenue by source
    var c = s.commerce, cw = $('commerce');
    if (c) {
      cw.classList.remove('hide');
      $('c-revenue').textContent = money(c.revenue);
      $('c-orders').textContent = fmt(c.orders);
      $('c-aov').textContent = money(c.aov);
      $('c-cr').textContent = c.cr + '%';
      trend('tc-revenue', c.trend && c.trend.revenue);
      trend('tc-orders', c.trend && c.trend.orders);
      $('w-revsrc').classList.remove('hide');
      var pfs = c.byPlatform || [];
      if (pfs.some(function (r) { return r.name !== 'web'; })) {
        $('w-revpf').classList.remove('hide');
        var maxP = Math.max.apply(null, pfs.map(function (r) { return r.revenue; }).concat([1]));
        $('p-revpf').innerHTML = pfs.map(function (r) {
          var w = Math.max(3, Math.round((r.revenue / maxP) * 100));
          return '<div class="bar clickable" data-fk="platform" data-fv="' + esc(r.name) + '"><div class="fill" style="width:' + w + '%"></div><span class="name">' + esc(platformLabel(r.name)) + '</span><span class="val">' + money(r.revenue) + '<span class="cr">' + r.orders + '×</span></span></div>';
        }).join('');
        Array.prototype.forEach.call($('p-revpf').querySelectorAll('.bar.clickable'), function (b) { b.onclick = function () { setFilter('platform', b.getAttribute('data-fv')); }; });
      } else $('w-revpf').classList.add('hide');
      var maxR = Math.max.apply(null, c.bySource.map(function (r) { return r.revenue; }).concat([1]));
      $('p-revsrc').innerHTML = c.bySource.map(function (r) {
        var w = Math.max(3, Math.round((r.revenue / maxR) * 100));
        return '<div class="bar" title="' + esc(r.name) + '"><div class="fill" style="width:' + w + '%"></div><span class="name">' + esc(sourceLabel(r.name)) + '</span><span class="val">' + money(r.revenue) + '<span class="cr">' + r.orders + '×</span></span></div>';
      }).join('') || '<div class="empty">No data yet</div>';
    } else { cw.classList.add('hide'); $('w-revsrc').classList.add('hide'); $('w-revpf').classList.add('hide'); }
    // site search
    if (s.search) {
      $('w-search').classList.remove('hide');
      $('searchMeta').textContent = fmt(s.search.total) + ' searches · ' + s.search.zeroShare + '% without results';
      renderSearch();
    } else $('w-search').classList.add('hide');
    // 404
    if (s.notFound && s.notFound.length) {
      $('w-404').classList.remove('hide');
      bars('p-404', s.notFound, { label: function (r) { return r.name + (r.fromPage ? '  ← ' + r.fromPage : ''); } });
    } else $('w-404').classList.add('hide');
    // scroll depth
    if (s.scrollPages && s.scrollPages.length) {
      $('w-scroll').classList.remove('hide');
      $('p-scroll').innerHTML = s.scrollPages.map(function (r) {
        return '<div class="bar" title="' + esc(r.name) + ' — ' + r.pageviews + ' measured views"><div class="fill" style="width:' + Math.max(3, r.avg) + '%"></div><span class="name">' + esc(r.name) + '</span><span class="val">' + r.avg + '%<span class="cr">' + r.deep + '% deep</span></span></div>';
      }).join('');
    } else $('w-scroll').classList.add('hide');
  }
  state.searchTab = 'top';
  function renderSearch() {
    var s = lastStats; if (!s || !s.search) return;
    var rows = s.search[state.searchTab] || [];
    bars('p-search', rows, { label: function (r) { return '“' + r.name + '”' + (state.searchTab === 'top' && r.zero ? '  ⚠ ' + r.zero + '× no results' : ''); } });
  }
  function renderProps(s) {
    var wrap = $('propsWrap');
    if (!s.properties || !s.properties.length) { wrap.classList.add('hide'); wrap.innerHTML = ''; return; }
    wrap.classList.remove('hide');
    wrap.innerHTML = s.properties.map(function (p) {
      var rows = p.values.map(function (v) {
        var max = Math.max.apply(null, p.values.map(function (x) { return x.visitors || 0; })) || 1;
        var w = Math.max(3, Math.round(((v.visitors || 0) / max) * 100));
        return '<div class="bar"><div class="fill" style="width:' + w + '%"></div><span class="name">' + esc(v.name) + '</span><span class="val">' + fmt(v.visitors) + '</span></div>';
      }).join('');
      return '<div class="card panel"><h3><span class="em">🏷️</span> ' + esc(p.key) + '</h3><div class="bars">' + rows + '</div></div>';
    }).join('');
  }

  function load() {
    var emptyMetrics = ['s-visitors', 's-pageviews', 's-bounce', 's-vpv', 's-dur'];
    var emptyPanels = ['p-pages', 'p-sources', 'p-countries', 'p-browsers', 'p-os', 'p-devices', 'p-goals', 'p-languages'];
    if (!state.site || state.site === 'no sites yet') {
      emptyMetrics.forEach(function (id) { $(id).textContent = '—'; });
      emptyPanels.forEach(function (id) { $(id).innerHTML = '<div class="empty">Add a site to begin</div>'; });
      $('chart').innerHTML = '';
      return;
    }
    renderFilters();
    api('/api/stats?' + statsQuery()).then(function (s) {
      if (s.error) return;
      lastStats = s;
      $('s-visitors').textContent = fmt(s.totals.visitors);
      $('s-pageviews').textContent = fmt(s.totals.pageviews);
      $('s-bounce').textContent = s.totals.bounce + '%';
      $('s-vpv').textContent = s.totals.viewsPerVisitor;
      $('s-dur').textContent = fmtDur(s.totals.duration);
      $('realtime').textContent = s.realtime;
      trend('t-visitors', s.trend && s.trend.visitors);
      trend('t-pageviews', s.trend && s.trend.pageviews);
      drawChart(s.series);
      renderPagesPanel();
      renderSourcesPanel();
      bars('p-countries', s.countries, { filterKey: 'country', label: function (r) { return flag(r.name) + ' ' + (NAMES[r.name] || r.name); } });
      bars('p-browsers', s.browsers, { filterKey: 'browser' });
      bars('p-os', s.os, { filterKey: 'os' });
      bars('p-devices', s.devices, { filterKey: 'device' });
      renderPlatformsPanel();
      bars('p-languages', s.languages, { filterKey: 'lang' });
      bars('p-goals', s.goals, { filterKey: 'goal', cr: true, label: function (r) { return '🎯 ' + r.name; } });
      renderProps(s);
      renderInsights(s);
      loadJourneys();
      loadFunnels();
    });
  }

  // ── series toggle (click legend) ──
  function syncLegend() {
    ['visitors', 'pageviews'].forEach(function (k) {
      var b = $('leg-' + k);
      if (b) b.setAttribute('aria-pressed', state.show[k] ? 'true' : 'false');
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.leg'), function (btn) {
    btn.addEventListener('click', function () {
      var k = btn.dataset.key, other = k === 'visitors' ? 'pageviews' : 'visitors';
      // Turning off the last visible line would empty the chart → flip instead of blanking.
      if (state.show[k] && !state.show[other]) { state.show[k] = false; state.show[other] = true; }
      else { state.show[k] = !state.show[k]; }
      localStorage.setItem('nyx_show', JSON.stringify(state.show));
      syncLegend();
      if (lastStats && lastStats.series) drawChart(lastStats.series);
    });
  });

  // ── visitor journeys: hand-rolled sankey (no lib) ──
  function loadJourneys() {
    if (!state.site) return;
    var q = statsQuery();
    api('/api/journeys?' + q).then(function (j) {
      if (j.error || !j.links) return;
      drawSankey(j);
      $('journeyMeta').textContent = '· ' + fmt(j.sessions) + ' sessions, top paths, 30-min session window';
    }).catch(function (e) { if (window.console) console.error('journeys:', e); });
  }
  function drawSankey(j) {
    var svg = $('journey');
    svg.innerHTML = '';
    if (!j.links.length) { svg.innerHTML = '<text x="20" y="40" fill="#888" font-size="13">Not enough data yet</text>'; return; }
    var W = Math.max(svg.clientWidth || 760, 640), H = 340, PAD = 24, colW = 150;
    var depths = j.maxDepth;
    var colX = function (d) { return PAD + d * ((W - 2 * PAD - colW) / Math.max(1, depths - 1)); };
    // node totals per column: sum of outgoing (or incoming for last col)
    var nodes = {}; // "d|path" → {in,out}
    j.links.forEach(function (l) {
      var a = nodes[l.depth + '|' + l.from] = nodes[l.depth + '|' + l.from] || { v: 0 };
      a.v += l.count;
      var b = nodes[(l.depth + 1) + '|' + l.to] = nodes[(l.depth + 1) + '|' + l.to] || { v: 0 };
      b.v = Math.max(b.v, 0) + l.count;
    });
    // layout: stack nodes per column by size
    var cols = {};
    Object.keys(nodes).forEach(function (k) {
      var d = +k.split('|')[0];
      (cols[d] = cols[d] || []).push({ key: k, path: k.slice(k.indexOf('|') + 1), v: nodes[k].v });
    });
    var maxTotal = 0;
    Object.keys(cols).forEach(function (d) {
      cols[d].sort(function (a, b) { return b.v - a.v; });
      var t = cols[d].reduce(function (s, n) { return s + n.v; }, 0);
      if (t > maxTotal) maxTotal = t;
    });
    var scale = (H - 2 * PAD - 40) / Math.max(1, maxTotal);
    var pos = {}; // key → {x,y,h}
    Object.keys(cols).forEach(function (d) {
      var y = PAD;
      cols[d].forEach(function (n) {
        var h = Math.max(4, n.v * scale);
        pos[n.key] = { x: colX(+d), y: y, h: h, v: n.v, path: n.path };
        y += h + 10;
      });
    });
    var ns = 'http://www.w3.org/2000/svg';
    var used = {}; // per-node offsets so ribbons stack instead of overlap
    j.links.forEach(function (l) {
      var a = pos[l.depth + '|' + l.from], b = pos[(l.depth + 1) + '|' + l.to];
      if (!a || !b) return;
      var h = Math.max(2, l.count * scale);
      var ao = used[l.depth + '|' + l.from] = used[l.depth + '|' + l.from] || { o: 0 };
      var bo = used['in' + (l.depth + 1) + '|' + l.to] = used['in' + (l.depth + 1) + '|' + l.to] || { o: 0 };
      var y1 = a.y + ao.o + h / 2, y2 = b.y + bo.o + h / 2;
      ao.o += h; bo.o += h;
      var x1 = a.x + 8, x2 = b.x;
      var mx = (x1 + x2) / 2;
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2);
      p.setAttribute('stroke', l.to === '✖ exit' ? 'rgba(248,113,113,.28)' : 'rgba(103,232,249,.30)');
      p.setAttribute('stroke-width', h);
      p.setAttribute('fill', 'none');
      p.style.transition = 'stroke .2s';
      var tip = l.from + ' → ' + l.to + ' · ' + l.count;
      p.addEventListener('mouseenter', function (e) { p.setAttribute('stroke', l.to === '✖ exit' ? 'rgba(248,113,113,.6)' : 'rgba(232,121,168,.6)'); showTip(e, tip); });
      p.addEventListener('mousemove', function (e) { showTip(e, tip); });
      p.addEventListener('mouseleave', function () { p.setAttribute('stroke', l.to === '✖ exit' ? 'rgba(248,113,113,.28)' : 'rgba(103,232,249,.30)'); hideTip(); });
      svg.appendChild(p);
    });
    Object.keys(pos).forEach(function (k) {
      var n = pos[k];
      var r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', n.x); r.setAttribute('y', n.y);
      r.setAttribute('width', 8); r.setAttribute('height', n.h);
      r.setAttribute('rx', 2);
      r.setAttribute('fill', n.path === '✖ exit' ? '#f87171' : n.path === '…' ? '#888' : '#e879a8');
      svg.appendChild(r);
      var t = document.createElementNS(ns, 'text');
      t.setAttribute('x', n.x + 12); t.setAttribute('y', n.y + Math.min(n.h / 2 + 4, 14));
      t.setAttribute('fill', '#cbd5e1'); t.setAttribute('font-size', '11');
      var label = n.path.length > 22 ? n.path.slice(0, 21) + '…' : n.path;
      t.textContent = label + ' (' + fmt(n.v) + ')';
      svg.appendChild(t);
    });
  }
  function showTip(e, text) { var tip = $('tip'); tip.textContent = text; tip.style.opacity = 1; tip.style.left = (e.pageX + 12) + 'px'; tip.style.top = (e.pageY - 10) + 'px'; }
  function hideTip() { $('tip').style.opacity = 0; }

  // ── share links ──
  var shareToken = null;
  $('shareBtn').onclick = function () {
    if (!state.site) return;
    api('/api/shares', { method: 'POST', body: JSON.stringify({ site: state.site }) }).then(function (s) {
      if (s.error) return;
      shareToken = s.token;
      $('shareDomain').textContent = s.domain;
      $('shareUrl').textContent = ORIGIN + '/share/' + s.token;
      $('shareModal').classList.remove('hide');
    });
  };
  $('copyShare').onclick = function () { navigator.clipboard.writeText($('shareUrl').textContent); $('copyShare').textContent = 'Copied ✓'; setTimeout(function () { $('copyShare').textContent = 'Copy link'; }, 1500); };
  $('revokeShare').onclick = function () { if (shareToken) api('/api/shares/' + shareToken, { method: 'DELETE' }).then(function () { $('shareModal').classList.add('hide'); }); };
  $('closeShare').onclick = function () { $('shareModal').classList.add('hide'); };

  // ── funnels ──
  function fmtPct(p) { return (p == null ? '—' : p + '%'); }
  function loadFunnels() {
    if (SHARE) { $('funnels').innerHTML = ''; $('addFunnelBtn').classList.add('hide'); return; }
    if (!state.site) return;
    api('/api/funnels?site=' + encodeURIComponent(state.site)).then(function (fs) {
      if (!Array.isArray(fs)) return;
      if (!fs.length) { $('funnels').innerHTML = '<div class="empty">No funnels yet — define one to see where visitors drop off.</div>'; return; }
      $('funnels').innerHTML = '';
      fs.forEach(function (f) {
        var q = state.from && state.to ? 'from=' + state.from + '&to=' + state.to : 'period=' + state.period;
        api('/api/funnels/' + f.id + '/stats?' + q).then(function (st) {
          if (st.error) return;
          var max = st.steps.length ? st.steps[0].visitors : 0;
          var html = '<div class="funnel"><div class="funnel-head"><strong>' + esc(st.name) + '</strong>' +
            '<button class="funnel-del" data-id="' + f.id + '" title="Delete funnel">×</button></div>';
          st.steps.forEach(function (s, i) {
            var w = max ? Math.max(2, (s.visitors / max) * 100) : 2;
            html += '<div class="funnel-step"><div class="funnel-label">' + (i + 1) + '. ' + (s.type === 'goal' ? '🎯 ' : '📄 ') + esc(s.label) + '</div>' +
              '<div class="funnel-bar-wrap"><div class="funnel-bar" style="width:' + w + '%"></div>' +
              '<span class="funnel-nums">' + fmt(s.visitors) + ' · ' + s.pctOfFirst + '%' + (i > 0 ? ' <span class="drop">−' + s.dropFromPrev + '%</span>' : '') + '</span></div></div>';
          });
          html += '</div>';
          $('funnels').insertAdjacentHTML('beforeend', html);
          $('funnels').querySelectorAll('.funnel-del').forEach(function (btn) {
            btn.onclick = function () { api('/api/funnels/' + btn.dataset.id, { method: 'DELETE' }).then(loadFunnels); };
          });
        });
      });
    });
  }

  function stepRow() {
    var div = document.createElement('div');
    div.className = 'step-row';
    div.innerHTML = '<select class="step-type"><option value="page">Page</option><option value="goal">Goal</option></select>' +
      '<input class="step-value" type="text" placeholder="/pricing or Signup" autocomplete="off">';
    return div;
  }
  $('addFunnelBtn').onclick = function () {
    $('funnelErr').textContent = ''; $('funnelName').value = '';
    var wrap = $('funnelSteps'); wrap.innerHTML = '';
    wrap.appendChild(stepRow()); wrap.appendChild(stepRow());
    $('funnelModal').classList.remove('hide'); $('funnelName').focus();
  };
  $('addStepBtn').onclick = function () { if ($('funnelSteps').children.length < 8) $('funnelSteps').appendChild(stepRow()); };
  $('cancelFunnel').onclick = function () { $('funnelModal').classList.add('hide'); };
  $('createFunnelBtn').onclick = function () {
    var steps = Array.prototype.map.call($('funnelSteps').children, function (row) {
      return { type: row.querySelector('.step-type').value, value: row.querySelector('.step-value').value.trim() };
    }).filter(function (s) { return s.value; });
    api('/api/funnels', { method: 'POST', body: JSON.stringify({ site: state.site, name: $('funnelName').value, steps: steps }) }).then(function (r) {
      if (r.error) { $('funnelErr').textContent = r.error; return; }
      $('funnelModal').classList.add('hide');
      loadFunnels();
    });
  };

  function boot() {
    hideLogin();
    syncLegend();
    loadSites().then(function () { load(); loadFunnels(); });
    // live dashboard: refresh every 15s while the tab is visible
    clearInterval(window.__rt);
    window.__rt = setInterval(function () {
      if (!state.site || document.hidden) return;
      load();
    }, 15000);
  }

  // share mode: resolve the token, lock the UI down to one site, skip login entirely
  function bootShare() {
    fetch('/api/share-info/' + SHARE).then(function (r) { return r.json(); }).then(function (info) {
      if (info.error) { document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#e879a8;font-family:sans-serif"><div><h2>🔗 Link expired</h2><p>This share link was revoked or never existed.</p></div></div>'; return; }
      hideLogin();
      state.site = info.domain;
      var sel = $('siteSelect');
      sel.innerHTML = '<option>' + esc(info.domain) + '</option>'; sel.disabled = true;
      ['addSiteBtn', 'logoutBtn', 'shareBtn', 'snippetBtn', 'addFunnelBtn'].forEach(function (id) { var el = $(id); if (el) el.classList.add('hide'); });
      syncLegend();
      load();
      clearInterval(window.__rt);
      window.__rt = setInterval(function () { if (!document.hidden) load(); }, 15000);
    });
  }

  if (SHARE) bootShare(); else if (TOKEN) boot(); else showLogin();
})();
