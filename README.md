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
- 🔍 **Segment everything.** Click any country, page, source, browser or campaign to filter the whole dashboard — stacked, with one-click chips.
- 🚦 **Campaigns & funnels.** Full UTM (`source` / `medium` / `campaign`), entry & exit pages, **goal conversion rates** and **custom event properties**.
- ⏱️ **Engagement time** — average time-on-page, measured privately (visible seconds only, no extra identifier).
- 🤖 **Bots & crawlers dropped** automatically, so your numbers stay honest.
- ⚡ **~2 KB tracker**, SPA-aware (tracks `pushState` / `popstate` route changes), optional **DNT / Global Privacy Control** honoring.
- 🗓️ **Data minimisation built in** — optional auto-purge of raw events after a retention window you choose.
- 🎯 **Custom events & goals**, **live visitors**, **trends**, **custom date ranges**, **CSV export**.
- 🛰️ **Agent-ready:** a clean `/api/v1` REST API (with segmentation params) + a `nyx` CLI (with `--json`).
- 🗄️ **Zero infra:** Express + SQLite. No Redis, no ClickHouse, no cloud.

## Quick start

```bash
git clone https://github.com/Open-Cosmic-Software/nyx-analytics.git
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

## Custom events, goals & properties

Track conversions from anywhere in your code — optionally with **properties** to break them down:

```js
nyx('Signup');
nyx('Upgrade', { plan: 'pro' });
nyx('Purchase', { plan: 'pro', amount: '49' });
```

Goals show up in the **Goals & conversions** panel with a **conversion rate** (% of visitors). Click a goal to drill into it — the whole dashboard re-segments to converters, and each property’s top values appear as their own breakdown. Pageviews stay separate, so your view counts stay clean.

## Segment everything

Click any row — a country, page, source, browser, OS, device, language or campaign — to **filter the entire dashboard** to that segment. Filters stack and show as removable chips. The same segmentation is available over the API and CLI:

```bash
nyx stats example.com 30d --country=DE --source=twitter.com
curl -H "Authorization: Bearer $NYX_API_KEY" \
  "https://analytics.example.com/api/v1/stats?site=example.com&period=30d&country=DE&medium=email"
```

## Campaigns, entry/exit & engagement

- **UTM campaigns** — `utm_source` / `utm_medium` / `utm_campaign` are captured automatically; switch the Sources panel between **Source / Medium / Campaign**.
- **Entry & exit pages** — switch the Pages panel between **Top / Entry / Exit** to see where visits start and end.
- **Engagement time** — the tracker reports how long each page was actually *visible* (a follow-up beacon, no new identifier), surfaced as **Avg. visit time**.
- **Custom date range** — pick any `from`/`to` window in the toolbar, or pass `--from`/`--to` to the API/CLI.

## Privacy controls on the tag

Opt-in flags on the `<script>` tag:

```html
<script defer data-domain="example.com"
        data-honor-dnt          <!-- skip tracking if DNT / Global Privacy Control is on -->
        data-track-outbound     <!-- auto-record clicks to other domains as events -->
        src="https://analytics.example.com/nyx.js"></script>
```

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
| `GET /api/v1/stats?site=&period=` | aggregated stats — `today \| 7d \| 30d \| 90d \| 12mo`, or `from=YYYY-MM-DD&to=YYYY-MM-DD` |
| `GET /api/v1/realtime?site=` | online count, 30-min pulse + recent events |

Add any of `country, source, page, browser, os, device, lang, medium, campaign, goal` to `/stats` to segment, e.g. `…/stats?site=example.com&period=30d&country=DE&medium=email`.

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
| `DATA_RETENTION_DAYS` | `0` | `0` = keep forever; `>0` purges raw events older than N days, daily (data minimisation) |

## Privacy & security

- No cookies, no cross-site tracking, **IPs never persisted**.
- Daily one-way visitor hash; salt rotates daily.
- **Data minimisation:** set `DATA_RETENTION_DAYS` to auto-purge raw events after your chosen window.
- **Respects DNT / Global Privacy Control** when you add `data-honor-dnt` to the tag.
- Engagement time adds **no new identifier** — it’s matched to the visitor’s own daily hash server-side.
- Custom event properties are capped (scalars only, size-limited) so they can’t become a PII dumping ground.
- Timing-safe auth; login and the collect endpoint are rate-limited.
- All visitor-supplied values are HTML-escaped before they reach the DOM.
- Run behind TLS; keep `.env` at `chmod 600`.

## Nyx Analytics vs. Google Analytics

| | Nyx Analytics | Google Analytics |
|---|---|---|
| Cookies / consent banner | ❌ none | ✅ required |
| Stores IPs / personal data | ❌ never | ✅ yes |
| Self-hosted, you own the data | ✅ | ❌ |
| Weight | ~2 KB | ~45 KB+ |
| Setup | 1 script + 1 process | tag manager, config… |

## License

[MIT](LICENSE) — built by **Nyx & Fabian** 🦞
