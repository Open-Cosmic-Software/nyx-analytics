/* Nyx Analytics tracker 🦞 — cookieless, ~2KB. Embed:
   <script defer data-domain="example.com" src="https://analytics.heynyx.dev/nyx.js"></script>

   Optional data-* flags on the <script> tag:
     data-honor-dnt        respect Do-Not-Track / Global Privacy Control (skip all tracking)
     data-track-outbound   auto-record clicks on links to other domains as events
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

    // ── engagement time: count the seconds a page is actually visible, report on leave ──
    var acc = 0, since = (document.visibilityState === 'visible') ? Date.now() : 0, engPath = location.pathname;
    function engaged() { return Math.round((acc + (since ? Date.now() - since : 0)) / 1000); }
    function flushEngagement() {
      var secs = engaged();
      if (secs >= 1) post({ d: domain, p: engPath, e: 'engagement', dur: secs });
    }
    function resetEngagement() { acc = 0; since = Date.now(); engPath = location.pathname; }
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
    history.pushState = function () { push.apply(this, arguments); onNav(); };
    var replace = history.replaceState;
    history.replaceState = function () { replace.apply(this, arguments); onNav(); };
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

    // ── initial pageview ──
    if (document.visibilityState === 'prerender') {
      document.addEventListener('visibilitychange', function f() {
        if (document.visibilityState !== 'prerender') { document.removeEventListener('visibilitychange', f); resetEngagement(); send(); }
      });
    } else { send(); }
  } catch (e) {}
})();
