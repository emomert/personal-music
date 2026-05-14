import { promises as fs } from 'fs';

// Spotify deprecated /v1/recommendations and /v1/artists/{id}/related-artists
// on 2024-11-27 for any newly-created app. This script builds a hybrid engine
// instead: Last.fm collaborative similarity supplies the candidate pool,
// Spotify supplies real metadata (URLs, album art, previews) and a genre-overlap
// boost so candidates closer to the user's taste rank higher.

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const SPOTIFY_BASE = 'https://api.spotify.com/v1';
const TARGET_REC_COUNT = 30;
const SEED_ARTIST_COUNT = 5;
const SEED_TRACK_COUNT = 5;
const SIMILAR_PER_SEED = 10;

class SpotifyAuthError extends Error {}

async function getSpotifyToken() {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new SpotifyAuthError(`Spotify token request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function spotifyFetch(token, endpoint) {
  const res = await fetch(`${SPOTIFY_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new SpotifyAuthError(`Spotify ${endpoint} auth error: ${res.status}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Spotify ${endpoint} failed: ${res.status} ${body.slice(0, 120)}`);
  }
  return res.json();
}

async function lastfmFetch(method, params = {}) {
  const qs = new URLSearchParams({ method, api_key: LASTFM_API_KEY, format: 'json', ...params });
  const res = await fetch(`${LASTFM_BASE}?${qs}`);
  if (!res.ok) throw new Error(`Last.fm ${method} failed: ${res.status}`);
  return res.json();
}

async function searchSpotifyArtist(token, name) {
  const data = await spotifyFetch(token, `/search?q=${encodeURIComponent(name)}&type=artist&limit=1`);
  return data.artists?.items?.[0] || null;
}

async function searchSpotifyTrack(token, name, artist) {
  const q = `track:"${name}" artist:"${artist}"`;
  const data = await spotifyFetch(token, `/search?q=${encodeURIComponent(q)}&type=track&limit=1`);
  return data.tracks?.items?.[0] || null;
}

async function getArtistTopTrack(token, artistId) {
  const data = await spotifyFetch(token, `/artists/${artistId}/top-tracks?market=US`);
  return data.tracks?.[0] || null;
}

function getLastfmArtistName(track) {
  return track.artist?.name || track.artist?.['#text'] || track.artist || null;
}

function genreOverlap(seedGenres, candidateGenres) {
  if (!seedGenres.size || !candidateGenres?.length) return 0;
  let hits = 0;
  for (const g of candidateGenres) if (seedGenres.has(g)) hits++;
  return hits;
}

function recKey(artist, name) {
  return `${(artist || '').toLowerCase()}|${(name || '').toLowerCase()}`;
}

async function main() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
    process.exit(2); // distinct exit code so workflow can detect "not configured"
  }
  if (!LASTFM_API_KEY) {
    console.error('LASTFM_API_KEY not set (needed as similarity signal)');
    process.exit(2);
  }

  let lastfmData;
  try {
    lastfmData = JSON.parse(await fs.readFile('./data/lastfm.json', 'utf-8'));
  } catch {
    console.error('data/lastfm.json missing — run fetch-lastfm.js first');
    process.exit(1);
  }

  const seedArtists = (lastfmData.topArtists_last7days || []).slice(0, SEED_ARTIST_COUNT);
  const seedTracks = (lastfmData.topTracks_last7days || []).slice(0, SEED_TRACK_COUNT);

  if (seedArtists.length === 0 && seedTracks.length === 0) {
    console.error('No seed artists or tracks in lastfm.json');
    process.exit(1);
  }

  const token = await getSpotifyToken();
  console.log('Spotify auth OK');

  // Build the seed-genre set from the user's top artists
  const seedGenres = new Set();
  const seedArtistMeta = [];
  for (const a of seedArtists) {
    try {
      const sp = await searchSpotifyArtist(token, a.name);
      if (sp) {
        seedArtistMeta.push({ name: a.name, spotify: sp });
        for (const g of sp.genres || []) seedGenres.add(g);
      }
    } catch (e) {
      console.warn(`seed lookup failed for ${a.name}: ${e.message}`);
    }
  }
  console.log(`Seed genres: ${[...seedGenres].slice(0, 8).join(', ') || '(none)'}`);

  const candidates = new Map(); // key -> rec object

  // ---- Track-similarity candidates ----
  for (const seed of seedTracks) {
    const seedArtistName = getLastfmArtistName(seed);
    if (!seed.name || !seedArtistName) continue;
    let similar;
    try {
      similar = await lastfmFetch('track.getsimilar', {
        track: seed.name,
        artist: seedArtistName,
        limit: String(SIMILAR_PER_SEED),
      });
    } catch (e) {
      console.warn(`track.getsimilar failed for ${seed.name}: ${e.message}`);
      continue;
    }
    for (const sim of similar?.similartracks?.track || []) {
      const simArtist = sim.artist?.name;
      if (!sim.name || !simArtist) continue;
      const key = recKey(simArtist, sim.name);
      if (candidates.has(key)) continue;

      let spTrack = null;
      let spArtist = null;
      try {
        spTrack = await searchSpotifyTrack(token, sim.name, simArtist);
        if (spTrack?.artists?.[0]?.id) {
          spArtist = await spotifyFetch(token, `/artists/${spTrack.artists[0].id}`);
        }
      } catch (e) {
        if (e instanceof SpotifyAuthError) throw e;
        console.warn(`spotify enrich failed for ${sim.name}: ${e.message}`);
      }

      const lastfmMatch = Number(sim.match) || 0;
      const overlap = genreOverlap(seedGenres, spArtist?.genres);
      candidates.set(key, {
        name: sim.name,
        artist: simArtist,
        album: spTrack?.album?.name || null,
        spotifyUrl: spTrack?.external_urls?.spotify || null,
        previewUrl: spTrack?.preview_url || null,
        image: spTrack?.album?.images?.[0]?.url || null,
        sourceTrack: seed.name,
        score: lastfmMatch * (1 + 0.25 * overlap),
        _hasSpotify: Boolean(spTrack),
      });
    }
  }

  // ---- Artist-similarity candidates ----
  for (const seed of seedArtists.slice(0, 3)) {
    let similar;
    try {
      similar = await lastfmFetch('artist.getsimilar', { artist: seed.name, limit: String(SIMILAR_PER_SEED) });
    } catch (e) {
      console.warn(`artist.getsimilar failed for ${seed.name}: ${e.message}`);
      continue;
    }
    for (const sim of similar?.similarartists?.artist || []) {
      if (!sim.name) continue;
      let spArtist = null;
      let spTopTrack = null;
      try {
        spArtist = await searchSpotifyArtist(token, sim.name);
        if (spArtist?.id) spTopTrack = await getArtistTopTrack(token, spArtist.id);
      } catch (e) {
        if (e instanceof SpotifyAuthError) throw e;
        console.warn(`spotify enrich failed for artist ${sim.name}: ${e.message}`);
      }

      const trackName = spTopTrack?.name || null;
      const key = recKey(sim.name, trackName || '__artist__');
      if (candidates.has(key)) continue;

      const lastfmMatch = Number(sim.match) || 0;
      const overlap = genreOverlap(seedGenres, spArtist?.genres);
      candidates.set(key, {
        name: trackName,
        artist: sim.name,
        album: spTopTrack?.album?.name || null,
        spotifyUrl: spTopTrack?.external_urls?.spotify || spArtist?.external_urls?.spotify || null,
        previewUrl: spTopTrack?.preview_url || null,
        image: spTopTrack?.album?.images?.[0]?.url || spArtist?.images?.[0]?.url || null,
        sourceArtist: seed.name,
        score: lastfmMatch * (1 + 0.25 * overlap),
        _hasSpotify: Boolean(spArtist),
      });
    }
  }

  const all = [...candidates.values()];
  // Prefer Spotify-enriched results, then by score
  all.sort((a, b) => {
    if (a._hasSpotify !== b._hasSpotify) return a._hasSpotify ? -1 : 1;
    return b.score - a.score;
  });
  const final = all.slice(0, TARGET_REC_COUNT).map(({ score, _hasSpotify, ...rest }) => rest);

  if (final.length === 0) {
    console.error('No candidates produced — refusing to overwrite recommendations.json');
    process.exit(1);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    source: 'hybrid_spotify_lastfm',
    seedArtists: seedArtists.map((a) => a.name),
    seedTracks: seedTracks.map((t) => t.name),
    seedGenres: [...seedGenres],
    tracks: final,
  };

  await fs.writeFile('./data/recommendations.json', JSON.stringify(result, null, 2));
  console.log(`Saved ${final.length} hybrid recommendations to data/recommendations.json`);
}

main().catch((e) => {
  if (e instanceof SpotifyAuthError) {
    console.error(`Spotify auth failed: ${e.message}`);
    process.exit(3); // distinct code so workflow can fall back
  }
  console.error(e);
  process.exit(1);
});
