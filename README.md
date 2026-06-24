# Nyx Analytics 🦞🌌

Privacy-first, **cookieless** web analytics you can self-host in minutes — in a cosmic-lobster style. A lightweight alternative to Plausible/umami: one tiny script, one Node process, one SQLite file.

![cosmic](public/assets/nyx-logo-256.png)

## Why

- **No cookies, no consent banner needed.** No cross-site tracking, no fingerprinting.
- **IPs are never stored.** Unique visitors are counted via a *daily, salted, one-way hash* — irreversible and rotated every day.
- **Region from the browser timezone**, never from IP geolocation.
- **Bots & crawlers are dropped** so your numbers stay honest.
- **~1 KB tracker**, SPA-aware (tracks `pushState`/`popstate` route changes).
- Multi-site: add domains in the dashboard, each gets an embed snippet.

## Quick start

```bash
git clone https://github.com/<you>/nyx-analytics.git
cd nyx-analytics
npm install
cp .env.example .env        # then edit: set WEB_PASSWORD, SESSION_SECRET, INGEST_SALT
node server.js              # http://127.0.0.1:3920
```

Put a TLS reverse proxy in front (the server binds to `127.0.0.1`). Example Caddy:

```
analytics.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3920
}
```

Then open the dashboard, log in with `WEB_PASSWORD`, click **+ Add site**, and paste the snippet into your site's `<head>`:

```html
<script defer data-domain="example.com" src="https://analytics.example.com/nyx.js"></script>
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3920` | Port (bound to 127.0.0.1) |
| `WEB_PASSWORD` | `nyx` | Dashboard passphrase |
| `SESSION_SECRET` | random | Session-token secret |
| `INGEST_SALT` | fixed | Salt for the daily visitor hash (rotate to reset identities) |
| `DB_PATH` | `./data/analytics.db` | SQLite path |

## How it works

- **`nyx.js`** sends a beacon (`navigator.sendBeacon`, `text/plain` so cross-origin needs no preflight) with the path, referrer, timezone and language. No personal data, no cookies.
- **`/api/collect`** parses the User-Agent (browser/OS/device), drops bots, maps timezone → country, derives the daily visitor hash, and stores one row per pageview.
- **Dashboard** aggregates with plain SQL: unique visitors, pageviews, bounce rate, views/visitor, a time series, top pages / sources / locations / browsers / OS / devices, and a 5-minute realtime count.

## Security

- Password compare is timing-safe; login and the collect endpoint are rate-limited.
- All visitor-supplied values are HTML-escaped before they reach the DOM.
- Run behind TLS. Keep `.env` at `chmod 600`.

## License

MIT — see [LICENSE](LICENSE). Built by Nyx & Fabian.
