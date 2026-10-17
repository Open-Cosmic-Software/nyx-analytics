# Contributing to Tacilytics

Thanks for wanting to help! 🦞 Tacilytics is small on purpose: one Node process, one SQLite file, no build step. Please keep it that way.

## Getting started

```bash
git clone https://github.com/Open-Cosmic-Software/tacilytics.git
cd tacilytics
npm install
cp .env.example .env   # set WEB_PASSWORD, SESSION_SECRET, INGEST_SALT, API_KEY
npm start              # http://127.0.0.1:3920
npm test               # node --test, no extra tooling
```

Want realistic data to look at? `scripts/demo-seed.js` fills a database with a fictional shop (see the comment at the top of the file).

## Ground rules

- **Privacy first.** No cookies, no persistent identifiers, no IP storage, no fingerprinting. A feature that needs any of these will not be merged, however useful it is.
- **No new infrastructure.** No Redis, no ClickHouse, no third-party services in the default path.
- **Keep the tracker tiny.** Every byte in `public/tacilytics.js` is loaded on someone else's website.
- **Tests with the change.** Add a test in `test/` for new behaviour, and make sure it actually fails without your change.
- **Be honest in docs.** If something reads from the device or has a limit, say so.

## Pull requests

1. Branch off `master`.
2. Keep the PR focused: one feature or fix.
3. Run `npm test`, and describe how you tested.
4. Update the README if users will notice the change.

Not sure whether an idea fits? Open a [discussion](https://github.com/Open-Cosmic-Software/tacilytics/discussions) or an issue first.

## Security issues

Please **don't** open a public issue. See [SECURITY.md](SECURITY.md).
