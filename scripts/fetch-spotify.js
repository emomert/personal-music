import { promises as fs } from 'fs';

// Multi-source music discovery engine.
//
// Spotify deprecated /v1/recommendations and /v1/artists/{id}/related-artists
// for newly-created apps in late 2024, and has progressively gated more
// endpoints since (audio-features, top-tracks, artist genres, preview URLs).
// Spotify-native discovery is no longer possible for personal-project apps.
//
// Instead this script blends THREE independent discovery signals:
//
//   1. lastfm-similar  — Last.fm collaborative similarity (track.getsimilar /
//                        artist.getsimilar). "Listeners of X also listen to Y."
//   2. listenbrainz    — ListenBrainz collaborative-filtering model
//                        (/cf/recommendation/user/{u}/recording). A separate
//                        CF model trained on a different user base.
//   3. lastfm-tag      — Last.fm tag-walk. For each seed artist, fetch its top
//                        tags, then top artists per tag. Surfaces music
//                        adjacent in *style* rather than listener overlap.
//
// Each source emits ranked candidates with a normalized score 0..1.
// Candidates are deduped across sources; items surfaced by multiple engines
// get their scores summed (a confidence boost). Output is the top 30, each
// tagged with which engines surfaced it (for UI badges).
//
// Spotify is then used only for METADATA enrichment (album art, open URL,
// preview when available). Spotify never acts as a discovery source here.

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LISTENBRAINZ_TOKEN = process.env.LISTENBRAINZ_TOKEN;
const LISTENBRAINZ_USER = process.env.LISTENBRAINZ_USER || 'emomert';

const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const SPOTIFY_BASE = 'https://api.spotify.com/v1';
const LB_BASE = 'https://api.listenbrainz.org/1';

const TARGET_REC_COUNT = 30;
const SEED_ARTIST_COUNT = 5;
const SEED_TRACK_COUNT = 5;
const SIMILAR_PER_SEED = 10;
const TAG_WALK_TAGS_PER_ARTIST = 3;
const TAG_WALK_ARTISTS_PER_TAG = 8;
const LB_CF_COUNT = 25;

class SpotifyAuthError extends Error {}

// ---------- HTTP helpers ----------

async function getSpotifyToken() {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new SpotifyAuthError(`Spotify token request failed: ${res.status} ${res.statusText}`);
  return (await res.json()).access_token;
}

async function spotifyFetch(token, endpoint) {
  const res = await fetch(`${SPOTIFY_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new SpotifyAuthError(`Spotify ${endpoint} token invalid: 401`);
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

async function lbFetch(endpoint, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${LB_BASE}${endpoint}${Object.keys(params).length ? '?' + qs : ''}`;
  const headers = { Accept: 'application/json' };
  if (LISTENBRAINZ_TOKEN) headers.Authorization = `Token ${LISTENBRAINZ_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null; // CF model may not be computed for this user
  if (!res.ok) throw new Error(`ListenBrainz ${endpoint} failed: ${res.status}`);
  return res.json();
}

// ---------- helpers ----------

function getLastfmArtistName(track) {
  return track.artist?.name || track.artist?.['#text'] || track.artist || null;
}

function recKey(artist, name) {
  return `${(artist || '').toLowerCase().trim()}|${(name || '').toLowerCase().trim()}`;
}

function normalizeScores(items, scoreKey = 'rawScore') {
  if (!items.length) return items;
  const max = Math.max(...items.map((i) => i[scoreKey] || 0));
  if (max <= 0) return items.map((i) => ({ ...i, score: 0 }));
  return items.map((i) => ({ ...i, score: (i[scoreKey] || 0) / max }));
}

// ---------- Source 1: Last.fm collaborative similarity ----------

async function fetchLastfmSimilarCandidates(seedArtists, seedTracks) {
  const out = [];

  for (const seed of seedTracks) {
    const seedArtist = getLastfmArtistName(seed);
    if (!seed.name || !seedArtist) continue;
    let data;
    try {
      data = await lastfmFetch('track.getsimilar', {
        track: seed.name,
        artist: seedArtist,
        limit: String(SIMILAR_PER_SEED),
      });
    } catch (e) {
      console.warn(`[lfm-similar] track.getsimilar(${seed.name}) failed: ${e.message}`);
      continue;
    }
    for (const sim of data?.similartracks?.track || []) {
      const simArtist = sim.artist?.name;
      if (!sim.name || !simArtist) continue;
      out.push({
        name: sim.name,
        artist: simArtist,
        rawScore: Number(sim.match) || 0,
        engine: 'lastfm-similar',
        sourceTrack: seed.name,
      });
    }
  }

  for (const seed of seedArtists.slice(0, 3)) {
    let data;
    try {
      data = await lastfmFetch('artist.getsimilar', { artist: seed.name, limit: String(SIMILAR_PER_SEED) });
    } catch (e) {
      console.warn(`[lfm-similar] artist.getsimilar(${seed.name}) failed: ${e.message}`);
      continue;
    }
    for (const sim of data?.similarartists?.artist || []) {
      if (!sim.name) continue;
      out.push({
        name: null,
        artist: sim.name,
        rawScore: Number(sim.match) || 0,
        engine: 'lastfm-similar',
        sourceArtist: seed.name,
      });
    }
  }

  return normalizeScores(out);
}

// ---------- Source 2: ListenBrainz CF ----------

async function fetchListenBrainzCandidates() {
  if (!LISTENBRAINZ_TOKEN) {
    console.warn('[listenbrainz] LISTENBRAINZ_TOKEN not set, skipping');
    return [];
  }

  let cf;
  try {
    cf = await lbFetch(`/cf/recommendation/user/${encodeURIComponent(LISTENBRAINZ_USER)}/recording`, {
      artist_type: 'raw',
      count: String(LB_CF_COUNT),
    });
  } catch (e) {
    console.warn(`[listenbrainz] CF fetch failed: ${e.message}`);
    return [];
  }
  if (!cf) {
    console.warn('[listenbrainz] no CF model computed for this user yet');
    return [];
  }

  const mbids = (cf?.payload?.mbids || []).filter((m) => m.recording_mbid);
  if (mbids.length === 0) return [];

  // Resolve names in one batch
  let metadata;
  try {
    metadata = await lbFetch('/metadata/recording/', {
      recording_mbids: mbids.map((m) => m.recording_mbid).join(','),
      inc: 'artist',
    });
  } catch (e) {
    console.warn(`[listenbrainz] metadata lookup failed: ${e.message}`);
    return [];
  }

  const out = [];
  for (const m of mbids) {
    const meta = metadata?.[m.recording_mbid];
    const trackName = meta?.recording?.name;
    const artistName = meta?.artist?.name || meta?.artist?.artists?.[0]?.name;
    if (!trackName || !artistName) continue;
    out.push({
      name: trackName,
      artist: artistName,
      rawScore: Number(m.score) || 0,
      engine: 'listenbrainz',
    });
  }

  console.log(`[listenbrainz] resolved ${out.length}/${mbids.length} CF recordings`);
  return normalizeScores(out);
}

// ---------- Source 3: Last.fm tag-walk ----------

async function fetchTagWalkCandidates(seedArtists, seedArtistNamesLower) {
  const tagFreq = new Map(); // tag -> total weight across seeds

  for (const seed of seedArtists) {
    let tagsData;
    try {
      tagsData = await lastfmFetch('artist.gettoptags', { artist: seed.name });
    } catch (e) {
      console.warn(`[tag-walk] gettoptags(${seed.name}) failed: ${e.message}`);
      continue;
    }
    const tags = tagsData?.toptags?.tag?.slice(0, TAG_WALK_TAGS_PER_ARTIST) || [];
    for (const t of tags) {
      const name = t.name?.toLowerCase();
      if (!name) continue;
      const w = (Number(t.count) || 0) / 100; // Last.fm tag counts are 0..100
      tagFreq.set(name, (tagFreq.get(name) || 0) + w);
    }
  }

  if (tagFreq.size === 0) return [];

  // Walk top tags by accumulated weight
  const topTags = [...tagFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const candidates = new Map(); // artistKey -> { name, rawScore, sourceTag }
  for (const [tag, weight] of topTags) {
    let topArtists;
    try {
      topArtists = await lastfmFetch('tag.gettopartists', { tag, limit: String(TAG_WALK_ARTISTS_PER_TAG) });
    } catch (e) {
      console.warn(`[tag-walk] tag.gettopartists(${tag}) failed: ${e.message}`);
      continue;
    }
    for (const a of topArtists?.topartists?.artist || []) {
      if (!a.name) continue;
      const lower = a.name.toLowerCase();
      if (seedArtistNamesLower.has(lower)) continue; // already in user's history
      const existing = candidates.get(lower);
      const rawScore = (existing?.rawScore || 0) + weight; // boost artists matching multiple tags
      if (existing) {
        existing.rawScore = rawScore;
      } else {
        candidates.set(lower, {
          name: null,
          artist: a.name,
          rawScore,
          engine: 'lastfm-tag',
          sourceTag: tag,
        });
      }
    }
  }

  console.log(`[tag-walk] ${candidates.size} candidates from tags: ${topTags.map(([t]) => t).join(', ')}`);
  return normalizeScores([...candidates.values()]);
}

// ---------- Spotify enrichment ----------

async function enrichWithSpotify(token, candidates) {
  for (const c of candidates) {
    try {
      if (c.name) {
        // Track-level lookup
        const q = `track:"${c.name}" artist:"${c.artist}"`;
        const data = await spotifyFetch(token, `/search?q=${encodeURIComponent(q)}&type=track&limit=1`);
        const t = data.tracks?.items?.[0];
        if (t) {
          c.album = t.album?.name || null;
          c.spotifyUrl = t.external_urls?.spotify || null;
          c.previewUrl = t.preview_url || null;
          c.image = t.album?.images?.[0]?.url || null;
          c._hasSpotify = true;
        }
      } else {
        // Artist-only candidate (similar-artists or tag-walk picks). Find a
        // representative track via search (top-tracks endpoint is gated).
        const artistData = await spotifyFetch(token, `/search?q=${encodeURIComponent(c.artist)}&type=artist&limit=1`);
        const ar = artistData.artists?.items?.[0];
        if (ar) {
          c.spotifyUrl = ar.external_urls?.spotify || null;
          c.image = ar.images?.[0]?.url || null;
          c._hasSpotify = true;
        }
        const trackData = await spotifyFetch(token, `/search?q=${encodeURIComponent(`artist:"${c.artist}"`)}&type=track&limit=1`);
        const t = trackData.tracks?.items?.[0];
        if (t) {
          c.name = t.name;
          c.album = t.album?.name || null;
          c.spotifyUrl = t.external_urls?.spotify || c.spotifyUrl;
          c.previewUrl = t.preview_url || null;
          c.image = t.album?.images?.[0]?.url || c.image;
        }
      }
    } catch (e) {
      if (e instanceof SpotifyAuthError) throw e;
      // Per-candidate Spotify failures are non-fatal
    }
  }
}

// ---------- Blending ----------

function blend(allLists) {
  // allLists: [ [candidates with .score, .engine, ...], ... ]
  const merged = new Map(); // key -> candidate (with engines[])
  for (const list of allLists) {
    for (const c of list) {
      const key = recKey(c.artist, c.name || '__artist__');
      const existing = merged.get(key);
      if (existing) {
        existing.score += c.score; // confidence boost for multi-source
        if (!existing.engines.includes(c.engine)) existing.engines.push(c.engine);
        // Carry attribution fields if missing
        existing.sourceTrack ||= c.sourceTrack;
        existing.sourceArtist ||= c.sourceArtist;
        existing.sourceTag ||= c.sourceTag;
      } else {
        merged.set(key, {
          name: c.name,
          artist: c.artist,
          score: c.score,
          engines: [c.engine],
          sourceTrack: c.sourceTrack,
          sourceArtist: c.sourceArtist,
          sourceTag: c.sourceTag,
        });
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

// ---------- Main ----------

async function main() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
    process.exit(2);
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

  // For tag-walk dedup: include user's broader history, not just last-7
  const knownArtistNames = new Set(
    [
      ...(lastfmData.topArtists_last7days || []),
      ...(lastfmData.topArtists_lastMonth || []),
      ...(lastfmData.topArtists_last3Months || []),
    ].map((a) => a.name?.toLowerCase()).filter(Boolean)
  );

  const token = await getSpotifyToken();
  console.log('Spotify auth OK');

  console.log('— Source 1: Last.fm similarity —');
  const lfmSim = await fetchLastfmSimilarCandidates(seedArtists, seedTracks);
  console.log(`  ${lfmSim.length} candidates`);

  console.log('— Source 2: ListenBrainz CF —');
  const lb = await fetchListenBrainzCandidates();
  console.log(`  ${lb.length} candidates`);

  console.log('— Source 3: Last.fm tag-walk —');
  const tag = await fetchTagWalkCandidates(seedArtists, knownArtistNames);
  console.log(`  ${tag.length} candidates`);

  const blended = blend([lfmSim, lb, tag]);
  console.log(`Blended pool: ${blended.length} unique candidates`);

  // Take a generous slice for enrichment, then filter to those with Spotify data
  const toEnrich = blended.slice(0, Math.min(60, blended.length));
  await enrichWithSpotify(token, toEnrich);

  // Prefer Spotify-enriched, then by score
  toEnrich.sort((a, b) => {
    if (Boolean(a._hasSpotify) !== Boolean(b._hasSpotify)) return a._hasSpotify ? -1 : 1;
    return b.score - a.score;
  });

  const final = toEnrich.slice(0, TARGET_REC_COUNT).map(({ _hasSpotify, score, ...rest }) => rest);

  if (final.length === 0) {
    console.error('No candidates produced — refusing to overwrite recommendations.json');
    process.exit(1);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    source: 'multi_source_v1',
    engines: ['lastfm-similar', 'listenbrainz', 'lastfm-tag'],
    seedArtists: seedArtists.map((a) => a.name),
    seedTracks: seedTracks.map((t) => t.name),
    counts: {
      'lastfm-similar': lfmSim.length,
      'listenbrainz': lb.length,
      'lastfm-tag': tag.length,
      blended: blended.length,
      final: final.length,
    },
    tracks: final,
  };

  await fs.writeFile('./data/recommendations.json', JSON.stringify(result, null, 2));
  console.log(`Saved ${final.length} blended recommendations to data/recommendations.json`);
}

main().catch((e) => {
  if (e instanceof SpotifyAuthError) {
    console.error(`Spotify auth failed: ${e.message}`);
    process.exit(3);
  }
  console.error(e);
  process.exit(1);
});
