import { promises as fs } from 'fs';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_USER = process.env.LASTFM_USER || 'emomert';
const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

async function fetchLastFm(method, extraParams = {}) {
  const params = new URLSearchParams({
    method,
    api_key: LASTFM_API_KEY,
    format: 'json',
    ...extraParams,
  });
  const res = await fetch(`${BASE_URL}?${params}`);
  if (!res.ok) throw new Error(`Last.fm ${method} failed: ${res.status}`);
  return res.json();
}

async function main() {
  if (!LASTFM_API_KEY) {
    console.error('LASTFM_API_KEY is not set');
    process.exit(1);
  }

  // Load top tracks
  let lastfmData;
  try {
    const raw = await fs.readFile('./data/lastfm.json', 'utf-8');
    lastfmData = JSON.parse(raw);
  } catch {
    console.error('lastfm.json not found. Run daily fetch first.');
    process.exit(1);
  }

  const topTracks = lastfmData.topTracks_last7days.slice(0, 5);
  const recommendations = [];
  const seen = new Set();

  for (const track of topTracks) {
    try {
      const similar = await fetchLastFm('track.getsimilar', {
        track: track.name,
        artist: track.artist?.name || track.artist?.['#text'],
        limit: '10',
      });

      for (const sim of similar?.similartracks?.track || []) {
        const key = `${sim.name}|${sim.artist?.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          recommendations.push({
            name: sim.name,
            artist: sim.artist?.name,
            album: null,
            spotifyUrl: null,
            previewUrl: null,
            image: sim.image?.find((i) => i.size === 'large')?.['#text'] || null,
            sourceTrack: track.name,
          });
        }
      }
    } catch (e) {
      console.warn(`Failed to get similar for ${track.name}:`, e.message);
    }
  }

  // Also get similar artists
  const topArtists = lastfmData.topArtists_last7days.slice(0, 3);
  for (const artist of topArtists) {
    try {
      const similar = await fetchLastFm('artist.getsimilar', {
        artist: artist.name,
        limit: '10',
      });

      for (const sim of similar?.similarartists?.artist || []) {
        const key = `${sim.name}|artist`;
        if (!seen.has(key)) {
          seen.add(key);
          recommendations.push({
            name: null,
            artist: sim.name,
            album: null,
            spotifyUrl: null,
            previewUrl: null,
            image: sim.image?.find((i) => i.size === 'large')?.['#text'] || null,
            sourceArtist: artist.name,
          });
        }
      }
    } catch (e) {
      console.warn(`Failed to get similar artists for ${artist.name}:`, e.message);
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    source: 'lastfm_fallback',
    seedArtists: topArtists.map((a) => a.name),
    seedTracks: topTracks.map((t) => t.name),
    tracks: recommendations.slice(0, 30),
  };

  await fs.writeFile('./data/recommendations.json', JSON.stringify(result, null, 2));
  console.log(`Saved ${recommendations.length} fallback recommendations.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
