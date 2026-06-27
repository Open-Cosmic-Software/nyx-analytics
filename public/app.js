/* Nyx Analytics dashboard 🦞 */
(function () {
  var TOKEN = localStorage.getItem('nyx_token') || '';
  var state = { site: localStorage.getItem('nyx_site') || '', period: '7d', from: '', to: '', sites: [], filters: {}, srcTab: 'sources', pageTab: 'pages' };
  var lastStats = null;
  // dashboard segmentation filters (whitelist mirrors the server's FILTER_COLS + goal)
  var FILTER_LABELS = { country: 'Country', source: 'Source', page: 'Page', browser: 'Browser', os: 'OS', device: 'Device', lang: 'Language', medium: 'Medium', campaign: 'Campaign', goal: 'Goal' };

  // build the stats/realtime query string from the current site, period/range and active filters
  function statsQuery() {
    var q = 'site=' + encodeURIComponent(state.site);
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
      sel.innerHTML = sites.map(function (s) { return '<option value="' + esc(s.domain) + '">' + esc(s.domain) + '</option>'; }).join('');
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
  $('copySnippet').onclick = function () {
    navigator.clipboard.writeText(snippetFor($('snipDomain').textContent)).then(function () {
      $('copySnippet').textContent = 'Copied ✓'; setTimeout(function () { $('copySnippet').textContent = 'Copy snippet'; }, 1500);
    });
  };

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
      var meta = [e.browser, e.device, src].filter(Boolean).map(esc).join(' · ');
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
        tip.innerHTML = '<strong>' + esc(d.label) + '</strong><br>🦞 ' + d.visitors + ' visitors<br>📄 ' + d.pageviews + ' views';
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
  function renderSourcesPanel() {
    var s = lastStats; if (!s) return;
    var tab = state.srcTab, fk = tab === 'mediums' ? 'medium' : tab === 'campaigns' ? 'campaign' : 'source';
    bars('p-sources', s[tab] || [], { filterKey: fk, label: function (r) { return tab === 'sources' && r.name === 'Direct' ? '➜ Direct / none' : r.name; } });
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
      bars('p-languages', s.languages, { filterKey: 'lang' });
      bars('p-goals', s.goals, { filterKey: 'goal', cr: true, label: function (r) { return '🎯 ' + r.name; } });
      renderProps(s);
    });
  }

  function boot() {
    hideLogin();
    loadSites().then(load);
    // live dashboard: refresh every 15s while the tab is visible
    clearInterval(window.__rt);
    window.__rt = setInterval(function () {
      if (!state.site || document.hidden) return;
      load();
    }, 15000);
  }

  if (TOKEN) boot(); else showLogin();
})();
