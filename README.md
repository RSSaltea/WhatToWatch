# What To Watch — whattowatch.uk

A film & TV tracker for two people: a **shared list** plus a personal list
each, with ratings (Rotten Tomatoes / IMDb / TMDB), region-aware streaming
availability with rent/buy prices, and automatic tracking of what plays on
the living-room Fire TV.

## How it's put together

- **Code** lives here on GitHub. **The site runs on Cloudflare** (Pages +
  Functions + a D1 database, all free tier) — Cloudflare auto-deploys every
  push to `main` and serves it at whattowatch.uk. GitHub Pages isn't used or
  needed; GitHub only stores the code.
- `public/` — the site (plain HTML/CSS/JS, no build step).
- `functions/api/` — the API: auth, lists, TMDB search/details, streaming
  providers + prices, scrobble ingest. Runs as Cloudflare Pages Functions.
- `schema.sql` — the D1 database schema (users, lists, scrobble inbox).
- `tv-scrobbler/` — Android app sideloaded onto the Fire TV; pushes
  "now playing" events to the API. Event-driven, no polling. See its README.
- Region is auto-detected per request from Cloudflare (`request.cf.country`)
  — no geolocation setup needed.

## One-time setup

### 1. Cloudflare Pages

In the Cloudflare dashboard: **Workers & Pages → Create → Pages →
Connect to Git** → pick `RSSaltea/WhatToWatch`.

- Build command: *(leave empty)*
- Build output directory: `public`

### 2. Database

```sh
npm install -g wrangler
wrangler login
wrangler d1 create whattowatch
```

Copy the printed `database_id` into `wrangler.toml` (replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`), commit and push. Then load the schema:

```sh
wrangler d1 execute whattowatch --remote --file=schema.sql
```

### 3. Secrets

In the Pages project → **Settings → Variables and Secrets**, add:

| Name | Required | What |
|---|---|---|
| `SESSION_SECRET` | yes | any long random string (signs login cookies) |
| `TMDB_API_KEY` | yes | free key from themoviedb.org → Settings → API |
| `DEVICE_TOKEN` | for TV tracking | long random string; put the same value in `tv-scrobbler/gradle.properties` |
| `OMDB_API_KEY` | optional | free key from omdbapi.com — adds Rotten Tomatoes + IMDb ratings |
| `RAPIDAPI_KEY` | optional | rapidapi.com key subscribed to "Streaming Availability" (Movie of the Night, free tier) — adds rent/buy £ prices |

Without the optional keys the site still works; it just shows TMDB ratings
only and providers without prices.

### 4. Domain

Pages project → **Custom domains → Add** → `whattowatch.uk`. Since the domain
is already on Cloudflare, DNS is wired up automatically.

### 5. Accounts

Open the site, create your account, and have your partner create theirs.
Registration closes automatically after two accounts.

### 6. TV tracking (optional)

Build and sideload the scrobbler — see [tv-scrobbler/README.md](tv-scrobbler/README.md).
Whatever plays on the Fire TV then appears in the site's **TV activity**
inbox, where either of you logs it as *me / partner / both* with one tap.

## Roadmap

- Per-episode tracking for TV shows
- Netflix viewing-history CSV import (backfill)
- Auto-matching scrobbled episode titles to shows
