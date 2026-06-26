<div align="center">

<img src="public/assets/nyx-logo-256.png" width="120" alt="Nyx Analytics" />

# Nyx Analytics

**Privacy-first, cookieless web analytics you can self-host in minutes.**
A lightweight, cosmic-styled alternative to Google Analytics — one tiny script, one Node process, one SQLite file. No cookies, no consent banner, no creepy tracking.

[![License: MIT](https://img.shields.io/badge/License-MIT-a855f7.svg)](LICENSE)
![Cookieless](https://img.shields.io/badge/cookies-zero-e879a8)
![No tracking](https://img.shields.io/badge/IPs%20stored-never-67e8f9)
![Node](https://img.shields.io/badge/node-%3E%3D18-4ade80)

<img src="docs/dashboard.png" width="820" alt="Nyx Analytics dashboard" />

</div>

---

## Why Nyx

- 🍪 **Cookieless & banner-free.** No cookies, no `localStorage`, no fingerprinting — nothing to consent to.
- 🛡️ **IPs are never stored.** Unique visitors are counted with a *daily, salted, one-way hash* that’s irreversible and rotated every day.
- 🌍 **Region from the browser timezone**, never from IP geolocation.
- 🤖 **Bots & crawlers dropped** automatically, so your numbers stay honest.
- ⚡ **~1 KB tracker**, SPA-aware (tracks `pushState` / `popstate` route changes).
- 🎯 **Custom events & goals**, **live visitors**, **trends**, **CSV export**.
- 🛰️ **Agent-ready:** a clean `/api/v1` REST API + a `nyx` CLI (with `--json`).
- 🗄️ **Zero infra:** Express + SQLite. No Redis, no ClickHouse, no cloud.

## Quick start

```bash
git clone https://github.com/OCS-Open-Cosmic-Software/nyx-analytics.git
cd nyx-analytics
npm install
cp .env.example .env     # set WEB_PASSWORD, SESSION_SECRET, INGEST_SALT, API_KEY
npm start                # http://127.0.0.1:3920
```

The server binds to `127.0.0.1` — put TLS in front. Example **Caddy**:

```
analytics.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3920
}
```

Open the dashboard, log in, click **+ Add site**, and drop the snippet into your `<head>`:

```html
<script defer data-domain="example.com" src="https://analytics.example.com/nyx.js"></script>
```

That’s it. Pageviews start flowing in — no cookie banner required.

## Custom events & goals

Track conversions from anywhere in your code:

```js
nyx('Signup');
nyx('Upgrade');
nyx('Newsletter');
```

They show up in the **Goals & events** panel and the live feed — separate from pageviews, so your view counts stay clean.

## Live visitors

Click **“● online now”** for a realtime view: a 30-minute pulse and a live feed of
who’s on the site right now — page, goal, country, browser/device and source —
auto-refreshing every few seconds.

<div align="center"><img src="docs/live.png" width="560" alt="Live visitors" /></div>

## Agent API

Everything the dashboard shows is available over a stable REST API, authenticated with a Bearer key:

```bash
curl -H "Authorization: Bearer $NYX_API_KEY" \
  "https://analytics.example.com/api/v1/stats?site=example.com&period=30d"
```

| Method & path | Description |
|---|---|
| `GET /api/v1` | API discovery |
| `GET /api/v1/sites` | list tracked sites |
| `POST /api/v1/sites` | add a site `{ domain }` |
| `GET /api/v1/stats?site=&period=` | aggregated stats — `today \| 7d \| 30d \| 90d \| 12mo` |
| `GET /api/v1/realtime?site=` | online count, 30-min pulse + recent events |

## CLI

```bash
export NYX_URL=https://analytics.example.com
export NYX_API_KEY=nyx_xxx

nyx sites
nyx stats example.com 30d
nyx live example.com --watch
nyx add example.com
```

Add `--json` to any command for machine-readable output — perfect for agents and scripts.

## How it works

`nyx.js` sends a tiny beacon (`navigator.sendBeacon`, `text/plain` so the cross-origin
request stays preflight-free) with the path, referrer, timezone and language — no
personal data, no cookies. The server parses the User-Agent (browser/OS/device),
drops bots, maps timezone → country, derives the **daily visitor hash**, and stores one
row per pageview. The dashboard aggregates it with plain SQL.

**The cookieless trade-off, honestly:** because there’s no persistent identifier, Nyx
counts unique visitors *per day* and can’t follow the same person across days or
devices. You get the 95 % that matters (how many, which pages, from where) with 0 %
cookie banner — the same approach as Plausible/Fathom.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3920` | Port (bound to 127.0.0.1) |
| `WEB_PASSWORD` | `nyx` | Dashboard passphrase |
| `SESSION_SECRET` | random | Session-token secret |
| `INGEST_SALT` | fixed | Salt for the daily visitor hash (rotate to reset identities) |
| `API_KEY` | — | Bearer key for the API / CLI |
| `DB_PATH` | `./data/analytics.db` | SQLite path |

## Privacy & security

- No cookies, no cross-site tracking, **IPs never persisted**.
- Daily one-way visitor hash; salt rotates daily.
- Timing-safe auth; login and the collect endpoint are rate-limited.
- All visitor-supplied values are HTML-escaped before they reach the DOM.
- Run behind TLS; keep `.env` at `chmod 600`.

## Nyx Analytics vs. Google Analytics

| | Nyx Analytics | Google Analytics |
|---|---|---|
| Cookies / consent banner | ❌ none | ✅ required |
| Stores IPs / personal data | ❌ never | ✅ yes |
| Self-hosted, you own the data | ✅ | ❌ |
| Weight | ~1 KB | ~45 KB+ |
| Setup | 1 script + 1 process | tag manager, config… |

## License

[MIT](LICENSE) — built by **Nyx & Fabian** 🦞
