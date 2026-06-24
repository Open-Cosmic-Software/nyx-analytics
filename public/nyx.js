/* Nyx Analytics tracker 🦞 — cookieless, ~1KB. Embed:
   <script defer data-domain="example.com" src="https://analytics.heynyx.dev/nyx.js"></script> */
(function () {
  try {
    var s = document.currentScript || document.querySelector('script[data-domain][src*="nyx.js"]');
    var domain = s && s.getAttribute('data-domain');
    if (!s || !domain) return;
    var endpoint = new URL(s.src).origin + '/api/collect';
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    var lang = (navigator.language || '').slice(0, 12);
    var first = true;

    function send(name) {
      // ignore local/preview hosts
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:') return;
      var payload = {
        d: domain,
        p: location.pathname,
        r: name ? '' : (first ? document.referrer : ''),
        tz: tz,
        l: lang,
        s: new URLSearchParams(location.search).get('utm_source') || '',
      };
      if (name) payload.n = name;
      else first = false;
      try {
        var body = JSON.stringify(payload);
        // text/plain keeps it a CORS-"simple" request, so the cross-origin beacon
        // sends without a preflight (which sendBeacon cannot do).
        if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return;
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: true, mode: 'no-cors' });
      } catch (e) {}
    }

    // SPA navigation: count a pageview on pushState / replaceState / back-forward.
    var lastPath = location.pathname;
    function onNav() {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      send();
    }
    var push = history.pushState;
    history.pushState = function () { push.apply(this, arguments); onNav(); };
    var replace = history.replaceState;
    history.replaceState = function () { replace.apply(this, arguments); onNav(); };
    window.addEventListener('popstate', onNav);

    // Custom events / goals:  nyx('Signup')  ·  nyx('Download')
    window.nyx = function (name) { if (name && typeof name === 'string') send(name.slice(0, 80)); };

    // initial pageview
    if (document.visibilityState === 'prerender') {
      document.addEventListener('visibilitychange', function f() {
        if (document.visibilityState !== 'prerender') { document.removeEventListener('visibilitychange', f); send(); }
      });
    } else { send(); }
  } catch (e) {}
})();
