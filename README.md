# Vestyr

Independent B2B brand & marketing — the vestyr.com website.

Static site served by **Cloudflare Workers Static Assets**, with a small Worker
handling `POST /api/contact` (Turnstile verification + Cloudflare Email).

No frontend framework. The site is one HTML page, hand-authored CSS and a little
vanilla JavaScript.

## Layout

```
src/Main.dc.html     authored page source (markup, CSS, page JS)
src/contact.js       contact form behaviour (fetch, Turnstile, states)
src/img/, *.svg      images, wordmarks, favicon, OG image
scripts/build.mjs    build → dist/
worker/index.ts      Worker: POST /api/contact only
wrangler.jsonc       Workers config (assets, routing, email binding)
design/              design-canvas artefacts — not deployed
dist/                build output (gitignored)
```

`src/Main.dc.html` is a Design Component file, which is why it has `<x-dc>` and
`<helmet>` wrappers — the same markup drives the design canvas in `design/`. The
build strips those wrappers and injects the production `<head>`, so none of that
syntax reaches the browser.

## Local development

```bash
npm install
cp .env.example .dev.vars   # then fill in real values locally
npm run dev                 # builds, then wrangler dev on http://localhost:8787
```

`npm run dev` serves the static site *and* the Worker together, so `/api/contact`
works locally. Editing frontend content only needs `npm run build`; no Cloudflare
account is required to preview the page itself.

`.dev.vars` holds local secrets and is gitignored. It is not used in production —
production values come from Cloudflare secrets and vars.

## Build

```bash
npm run build       # → dist/
```

Set the public Turnstile site key at build time:

```bash
TURNSTILE_SITE_KEY=0x4AAAAAAA... npm run build
```

The build fails on unresolved template tokens, missing assets, asset references
that do not exist in `dist/`, and any localhost URL in the output.

## Deploy

Cloudflare Workers Builds deploys automatically from the production branch. To
deploy by hand:

```bash
npm run deploy      # npm run build && wrangler deploy
```

## Configuration

| Name | Kind | Where |
| --- | --- | --- |
| `TURNSTILE_SECRET_KEY` | secret | `wrangler secret put` / dashboard |
| `CONTACT_RECIPIENT` | secret or var | dashboard |
| `CONTACT_SENDER` | var | `wrangler.jsonc` (`website@vestyr.com`) |
| `TURNSTILE_SITE_KEY` | build env var | Workers Builds build settings |
| `CONTACT_EMAIL` | send_email binding | `wrangler.jsonc` |
| `ASSETS` | assets binding | `wrangler.jsonc` |

Secrets are never committed. `.env.example` lists variable names only.

## Contact endpoint

`POST /api/contact`, JSON in, JSON out.

Accepts `name`, `email`, `company`, `message`, `diagnostic`, `website`
(honeypot) and `turnstileToken`. Validates method, content type, body size,
required fields, email format and field lengths; silently discards honeypot
hits; verifies the Turnstile token server-side; then sends via the
`CONTACT_EMAIL` binding with the visitor's address as `Reply-To`.

Responses are `{"success":true}` or `{"success":false,"error":"…"}`. Internal
failures are logged without the submitted personal data and returned to the
browser as a generic message.
