# ~/music — Personal Music Dashboard

A retro-terminal-style personal website that combines your Last.fm & ListenBrainz listening history with weekly music recommendations.

## Features

- **Homepage**: Now Playing / Last Played, total scrobbles, quick stats, recent history preview
- **Dashboard**: Interactive charts (Top Artists, Tracks, Albums) with period switching (7 days, month, 3 months, year, all time)
- **Recommendations**: Weekly curated music recommendations based on your listening habits
- **Data Pipeline**: Fully automated via GitHub Actions — daily history fetch + weekly recommendations

## Tech Stack

- [Astro](https://astro.build/) — Static site generator
- [Tailwind CSS](https://tailwindcss.com/) — Styling
- [Chart.js](https://www.chartjs.org/) — Dashboard charts
- [GitHub Actions](https://github.com/features/actions) — Data fetching automation
- [Netlify](https://www.netlify.com/) — Hosting

## Design

Retro CRT terminal aesthetic with:
- Phosphor green & amber glow effects
- CRT scanlines and subtle flicker
- JetBrains Mono monospace typography
- Boxy, terminal-inspired UI components

## Setup

### 1. Fork / Push to GitHub

Push this repo to your GitHub account.

### 2. Add Repository Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `LASTFM_API_KEY` | Your Last.fm API key |
| `LISTENBRAINZ_TOKEN` | Your ListenBrainz user token |
| `SPOTIFY_CLIENT_ID` | *(Optional)* Spotify Client ID |
| `SPOTIFY_CLIENT_SECRET` | *(Optional)* Spotify Client Secret |

### 3. Configure GitHub Actions

The workflows are in `.github/workflows/`:

- **`daily.yml`** — Runs every day at 03:00 UTC, fetches Last.fm + ListenBrainz data
- **`weekly.yml`** — Runs every Monday at 04:00 UTC, generates recommendations

> **Note about Spotify**: Spotify's Web API requires the app owner to have a **Premium subscription**. The workflow is smart — it **tries Spotify first**, and if it gets a 403 error (Premium required), it **automatically falls back** to Last.fm similar tracks/artists. When you get a Premium-linked app (from a friend or yourself), just update the `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` secrets — no code changes needed!

### 4. Deploy to Netlify

1. Connect your GitHub repo to Netlify
2. Build settings are already configured in `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
3. Deploy!

### 5. Update Site URL

Change the `site` URL in `astro.config.mjs` to your actual Netlify domain.

## Local Development

```bash
npm install
npm run dev
```

To fetch data locally:

```bash
export LASTFM_API_KEY=your_key
export LISTENBRAINZ_TOKEN=your_token
node scripts/fetch-lastfm.js
node scripts/fetch-listenbrainz.js
node scripts/fetch-recommendations-fallback.js
```

Then build:

```bash
npm run build
```

## Project Structure

```
├── .github/workflows/    # GitHub Actions automation
├── data/                 # Fetched JSON data (committed by Actions)
├── scripts/              # Node.js data fetching scripts
├── src/
│   ├── components/       # Astro components (Charts, Navigation)
│   ├── layouts/          # Page layouts
│   ├── pages/            # Site pages (Home, Dashboard, Recommendations)
│   └── styles/           # Global CSS + Tailwind config
├── astro.config.mjs
└── netlify.toml
```

## Data Sources

- **Last.fm** — Scrobbles, top artists/tracks/albums, user stats
- **ListenBrainz** — Listen history, additional stats
- **Spotify** *(optional)* — Advanced recommendations based on audio features
- **Last.fm Fallback** — Similar tracks & artists when Spotify is unavailable

## License

Personal project — feel free to fork and adapt for your own listening history!
