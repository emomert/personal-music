# ~/music — Personal Music Dashboard

Astro static site that combines your Last.fm + ListenBrainz listening history with weekly Spotify-enriched recommendations.

## Features

- **Home** — Now Playing / Last Played, total scrobbles, quick stats, recent history
- **Dashboard** — Top Artists / Tracks / Albums charts with period switching (7 days → all time)
- **Discover** — Weekly recommendations from a hybrid Spotify + Last.fm engine
- **Automated pipeline** — GitHub Actions runs daily history fetch + weekly recommendations

## Tech Stack

- [Astro](https://astro.build/) — static site generator
- [Tailwind CSS v4](https://tailwindcss.com/) — styling
- [Chart.js](https://www.chartjs.org/) — dashboard charts
- [GitHub Actions](https://github.com/features/actions) — data fetching automation
- [Netlify](https://www.netlify.com/) — hosting

## Design

Light, editorial aesthetic — cream background, navy ink, amber accent. Lora for headings, Inter for body, JetBrains Mono for numerics.

## Recommendations engine

Spotify deprecated `/v1/recommendations` and `/v1/artists/{id}/related-artists` on **2024-11-27** for newly-created apps, so the original "ask Spotify for recs" approach no longer works. This project uses a **hybrid engine** instead:

1. Pull your last-7-days top artists & tracks from Last.fm.
2. For each seed, fetch Last.fm's collaborative-similarity neighbors (`track.getsimilar`, `artist.getsimilar`) — these endpoints still work and capture real listener overlap.
3. For each candidate, look it up on Spotify's still-public endpoints (`/search`, `/artists/{id}`, `/artists/{id}/top-tracks`) to attach real album art, Spotify URLs, and (when available) preview clips.
4. Score each candidate by `lastfm_match × (1 + 0.25 × genre_overlap_with_seeds)` so candidates closer to your taste rank higher.
5. Prefer Spotify-enriched results, dedupe, keep top 30.

If Spotify credentials are missing or auth fails, the workflow automatically falls back to a Last.fm-only similarity engine — same JSON shape, no album art.

## Setup

### 1. Push to GitHub

Fork or push this repo to your own GitHub account.

### 2. Add repository secrets

**Settings → Secrets and variables → Actions → New repository secret:**

| Secret                  | Required | Notes                                    |
| ----------------------- | -------- | ---------------------------------------- |
| `LASTFM_API_KEY`        | Yes      | https://www.last.fm/api/account/create   |
| `LISTENBRAINZ_TOKEN`    | Yes      | https://listenbrainz.org/profile/        |
| `SPOTIFY_CLIENT_ID`     | Optional | https://developer.spotify.com/dashboard  |
| `SPOTIFY_CLIENT_SECRET` | Optional | Same Spotify app                         |

For the Spotify app, the **Client Credentials** flow is enough — no redirect URI, no user OAuth, no Premium required. The hybrid engine never needs user-scoped data.

### 3. GitHub Actions workflows

In `.github/workflows/`:

- **`daily.yml`** — every day at 03:00 UTC, fetches Last.fm + ListenBrainz history.
- **`weekly.yml`** — every Monday at 04:00 UTC, runs the hybrid recommendation engine (with automatic Last.fm fallback on Spotify auth/missing-creds).

Both can be triggered manually from the Actions tab.

### 4. Deploy to Netlify

1. Connect the GitHub repo to Netlify.
2. Build settings come from `netlify.toml` (`npm run build` → `dist`).
3. Update the `site` URL in `astro.config.mjs` to match your Netlify domain.

## Local development

```powershell
npm install
npm run dev
```

To run a fetch script locally on **Windows / PowerShell**:

```powershell
$env:LASTFM_API_KEY = "your_key"
$env:LISTENBRAINZ_TOKEN = "your_token"
$env:SPOTIFY_CLIENT_ID = "your_client_id"
$env:SPOTIFY_CLIENT_SECRET = "your_client_secret"

node scripts/fetch-lastfm.js
node scripts/fetch-listenbrainz.js
node scripts/fetch-spotify.js          # hybrid engine
# or
node scripts/fetch-recommendations-fallback.js   # Last.fm-only
```

On **macOS / Linux** use `export VAR=...` instead of `$env:VAR = ...`.

Then build:

```powershell
npm run build
```

## Project structure

```
.
├── .github/workflows/    # daily.yml, weekly.yml
├── data/                 # Generated JSON (committed by Actions)
├── scripts/              # Node fetch scripts
├── src/
│   ├── components/       # DashboardCharts, Navigation
│   ├── layouts/          # Layout.astro (imports global.css)
│   ├── pages/            # index, dashboard, recommendations
│   └── styles/           # global.css (Tailwind v4 + theme tokens)
├── astro.config.mjs
└── netlify.toml
```

## Data sources

- **Last.fm** — scrobbles, top artists/tracks/albums, user stats, similarity graph.
- **ListenBrainz** — listen history, additional stats.
- **Spotify** — metadata enrichment for recommendations (album art, Spotify URLs, previews, genres).

## License

Personal project — fork and adapt for your own listening history.
