import { promises as fs } from 'fs';

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

async function getSpotifyToken() {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function spotifyFetch(token, endpoint) {
  const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify API ${endpoint} failed: ${res.status}`);
  return res.json();
}

async function main() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.error('Spotify credentials are not set');
    process.exit(1);
  }

  const token = await getSpotifyToken();

  // Load top artists from lastfm data
  let lastfmData;
  try {
    const raw = await fs.readFile('./data/lastfm.json', 'utf-8');
    lastfmData = JSON.parse(raw);
  } catch {
    console.error('lastfm.json not found. Run daily fetch first.');
    process.exit(1);
  }

  const topArtists = lastfmData.topArtists_last7days.slice(0, 5);
  const seedArtistIds = [];

  for (const artist of topArtists) {
    try {
      const search = await spotifyFetch(token, `/search?q=${encodeURIComponent(artist.name)}&type=artist&limit=1`);
      if (search.artists?.items?.[0]) {
        seedArtistIds.push(search.artists.items[0].id);
      }
    } catch (e) {
      console.warn(`Failed to search artist ${artist.name}:`, e.message);
    }
  }

  if (seedArtistIds.length === 0) {
    console.error('No seed artists found on Spotify');
    process.exit(1);
  }

  console.log(`Fetching recommendations with seeds: ${seedArtistIds.join(',')}`);
  const recs = await spotifyFetch(
    token,
    `/recommendations?seed_artists=${seedArtistIds.slice(0, 5).join(',')}&limit=30`
  );

  const enrichedTracks = [];
  for (const track of recs.tracks || []) {
    enrichedTracks.push({
      name: track.name,
      artist: track.artists.map((a) => a.name).join(', '),
      album: track.album.name,
      spotifyUrl: track.external_urls?.spotify || null,
      previewUrl: track.preview_url || null,
      image: track.album.images?.[0]?.url || null,
    });
  }

  const result = {
    generatedAt: new Date().toISOString(),
    seedArtists: topArtists.map((a) => a.name),
    tracks: enrichedTracks,
  };

  await fs.writeFile('./data/recommendations.json', JSON.stringify(result, null, 2));
  console.log('Recommendations saved to data/recommendations.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
