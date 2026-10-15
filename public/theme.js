/* Tacilytics — theme + language, applied before first paint (loaded synchronously in <head>). */
(function () {
  var d = document.documentElement;
  function pref() { try { return localStorage.getItem('tacilytics_theme') || 'system'; } catch (e) { return 'system'; } }
  function apply() {
    var p = pref();
    var light = p === 'light' || (p === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
    d.setAttribute('data-theme', light ? 'light' : 'dark');
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', light ? '#f4f8f7' : '#071114');
  }
  apply();
  if (window.matchMedia) { try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply); } catch (e) {} }
  window.TaciTheme = { get: pref, set: function (v) { try { localStorage.setItem('tacilytics_theme', v); } catch (e) {} apply(); } };
})();
