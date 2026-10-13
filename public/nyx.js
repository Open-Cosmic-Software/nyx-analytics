/* Nyx Analytics tracker 🦞 — cookieless, ~2KB. Embed:
   <script defer data-domain="example.com" src="https://analytics.heynyx.dev/nyx.js"></script>

   Optional data-* flags on the <script> tag:
     data-honor-dnt        respect Do-Not-Track / Global Privacy Control (skip all tracking)
     data-track-outbound   auto-record clicks on links to other domains as events
     data-track-404        record a "404" event when the page is an error page
                           (value = CSS selector that only exists on error pages, e.g. "body.is-act-error")
     data-track-search     record "Search" events: value = query-string parameter, e.g. "search"
                           (results counted via data-search-results selector, default ".product-box")
   Purchases: nyx('Purchase', { value: 49.90, currency: 'EUR', items: 3 }) on the thank-you page
   Custom events:  nyx('Signup')  ·  nyx('Signup', { plan: 'pro' }) */
(function () {
  try {
    var s = document.currentScript || document.querySelector('script[data-domain][src*="nyx.js"]');
    var domain = s && s.getAttribute('data-domain');
    if (!s || !domain) return;

    // Privacy signals (opt-in): if the visitor asked not to be tracked, honour it and do nothing.
    if (s.hasAttribute('data-honor-dnt')) {
      var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
      if (navigator.globalPrivacyControl === true || dnt === '1' || dnt === 'yes') return;
    }

    var endpoint = new URL(s.src).origin + '/api/collect';
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    var lang = (navigator.language || '').slice(0, 12);
    var qs = new URLSearchParams(location.search);
    var first = true;

    function post(payload) {
      // ignore local/preview hosts
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:') return;
      try {
        var body = JSON.stringify(payload);
        // text/plain keeps it a CORS-"simple" request, so the cross-origin beacon
        // sends without a preflight (which sendBeacon cannot do).
        if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return;
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: true, mode: 'no-cors' });
      } catch (e) {}
    }

    function send(name, props) {
      var payload = {
        d: domain,
        p: location.pathname,
        r: name ? '' : (first ? document.referrer : ''),
        tz: tz,
        l: lang,
        s: qs.get('utm_source') || '',
        um: qs.get('utm_medium') || '',
        uc: qs.get('utm_campaign') || '',
      };
      if (name) { payload.n = name; if (props && typeof props === 'object') payload.pr = props; }
      else first = false;
      post(payload);
    }

    // ── engagement time + scroll depth: report on leave ──
    var acc = 0, since = (document.visibilityState === 'visible') ? Date.now() : 0, engPath = location.pathname;
    var maxScroll = 0;
    function measureScroll() {
      var de = document.documentElement, b = document.body || de;
      var h = Math.max(de.scrollHeight, b.scrollHeight), vh = window.innerHeight || de.clientHeight;
      var y = window.pageYOffset || de.scrollTop || 0;
      // short pages that fit the screen count as fully seen
      var pct = h <= vh ? 100 : Math.round(((y + vh) / h) * 100);
      if (pct > maxScroll) maxScroll = Math.min(100, pct);
    }
    var scrollTimer = 0;
    window.addEventListener('scroll', function () { if (!scrollTimer) scrollTimer = setTimeout(function () { scrollTimer = 0; measureScroll(); }, 200); }, { passive: true });
    window.addEventListener('load', measureScroll);
    function engaged() { return Math.round((acc + (since ? Date.now() - since : 0)) / 1000); }
    function flushEngagement() {
      var secs = engaged();
      measureScroll();
      if (secs >= 1 || maxScroll > 0) post({ d: domain, p: engPath, e: 'engagement', dur: secs, sc: maxScroll });
    }
    function resetEngagement() { acc = 0; since = Date.now(); engPath = location.pathname; maxScroll = 0; }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { if (since) { acc += Date.now() - since; since = 0; } flushEngagement(); }
      else if (!since) { since = Date.now(); }
    });
    window.addEventListener('pagehide', flushEngagement);

    // ── SPA navigation: count a pageview on pushState / replaceState / back-forward ──
    var lastPath = location.pathname;
    function onNav() {
      if (location.pathname === lastPath) return;
      flushEngagement();           // close out the page we're leaving
      lastPath = location.pathname;
      resetEngagement();           // start timing the new page
      send();
    }
    var push = history.pushState;
    history.pushState = function () { push.apply(this, arguments); onNav(); if (window.__nyxSearchCheck) window.__nyxSearchCheck(); };
    var replace = history.replaceState;
    history.replaceState = function () { replace.apply(this, arguments); onNav(); if (window.__nyxSearchCheck) window.__nyxSearchCheck(); };
    window.addEventListener('popstate', onNav);

    // ── custom events / goals:  nyx('Signup')  ·  nyx('Signup', { plan: 'pro' }) ──
    window.nyx = function (name, props) { if (name && typeof name === 'string') send(name.slice(0, 80), props); };

    // ── optional automatic outbound-link tracking ──
    if (s.hasAttribute('data-track-outbound')) {
      document.addEventListener('click', function (ev) {
        var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
        if (!a) return;
        try {
          var u = new URL(a.href, location.href);
          if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== location.hostname) {
            window.nyx('Outbound Link', { url: u.hostname + u.pathname });
          }
        } catch (e) {}
      }, true);
    }

    // ── 404 pages: one event with the broken URL and where the visitor came from ──
    var cfg = window.nyxConfig || {};
    var sel404 = s.getAttribute('data-track-404') || cfg.track404 || '';
    function check404() {
      try {
        if (sel404 && document.querySelector(sel404)) {
          var from = '';
          try { var ru = new URL(document.referrer); from = ru.hostname === location.hostname ? ru.pathname : ru.hostname; } catch (e) {}
          window.nyx('404', { url: location.pathname, from: from });
        }
      } catch (e) {}
    }

    // ── site search: query + number of results ──
    //   classic results page:  data-track-search="search"      (?search=…)
    //   overlay search in the URL hash: nyxConfig.searchHash = { param: 'mbai', key: 'query' }  (#mbai=query%3D…)
    //   nyxConfig.searchResults / searchEmpty: CSS selectors to count hits / detect "no results"
    var searchParam = s.getAttribute('data-track-search') || cfg.searchParam || '';
    var searchHash = cfg.searchHash || null;
    var resSel = s.getAttribute('data-search-results') || cfg.searchResults || '.product-box';
    var emptySel = cfg.searchEmpty || '';
    var lastQ = '', searchTimer = 0;
    function reportSearch(q) {
      q = (q || '').trim().toLowerCase().slice(0, 60);
      if (!q || q === lastQ) return;
      clearTimeout(searchTimer);
      // wait until the results have rendered (and the visitor stopped typing)
      searchTimer = setTimeout(function () {
        if (q === lastQ) return;
        lastQ = q;
        var n = 0;
        try {
          if (emptySel && document.querySelector(emptySel)) n = 0;
          else n = document.querySelectorAll(resSel).length;
        } catch (e) {}
        window.nyx('Search', { q: q, results: n });
      }, 2500);
    }
    function searchFromHash() {
      if (!searchHash) return '';
      var h = new URLSearchParams(location.hash.replace(/^#/, '')).get(searchHash.param);
      if (!h) return '';
      return new URLSearchParams(h).get(searchHash.key || 'query') || '';
    }
    function checkSearch() {
      if (searchParam) reportSearch(new URLSearchParams(location.search).get(searchParam) || '');
      if (searchHash) reportSearch(searchFromHash());
    }
    if (searchHash) {
      window.addEventListener('hashchange', function () { reportSearch(searchFromHash()); });
      window.__nyxSearchCheck = function () { reportSearch(searchFromHash()); }; // overlay updates the hash via history API
    }
    function afterLoad(fn) { if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(fn, 0); else document.addEventListener('DOMContentLoaded', fn); }
    afterLoad(function () { check404(); checkSearch(); });

    // ── initial pageview ──
    if (document.visibilityState === 'prerender') {
      document.addEventListener('visibilitychange', function f() {
        if (document.visibilityState !== 'prerender') { document.removeEventListener('visibilitychange', f); resetEngagement(); send(); }
      });
    } else { send(); }
  } catch (e) {}
})();
