import { promises as fs } from 'fs';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_USER = 'emomert';
const BASE_URL = 'http://ws.audioscrobbler.com/2.0/';

async function fetchLastFm(method, extraParams = {}) {
  const params = new URLSearchParams({
    method,
    user: LASTFM_USER,
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

  const results = {};

  // Recent tracks
  console.log('Fetching recent tracks...');
  const recent = await fetchLastFm('user.getrecenttracks', { limit: '200', page: '1' });
  results.recentTracks = recent?.recenttracks?.track || [];

  // User info
  console.log('Fetching user info...');
  const userInfo = await fetchLastFm('user.getinfo');
  results.userInfo = userInfo?.user || {};

  // Top artists periods
  const periods = [
    { key: '7day', label: 'last7days' },
    { key: '1month', label: 'lastMonth' },
    { key: '3month', label: 'last3Months' },
    { key: '12month', label: 'lastYear' },
    { key: 'overall', label: 'allTime' },
  ];

  for (const period of periods) {
    console.log(`Fetching top artists (${period.key})...`);
    const data = await fetchLastFm('user.gettopartists', { period: period.key, limit: '50' });
    results[`topArtists_${period.label}`] = data?.topartists?.artist || [];

    console.log(`Fetching top albums (${period.key})...`);
    const albumData = await fetchLastFm('user.gettopalbums', { period: period.key, limit: '50' });
    results[`topAlbums_${period.label}`] = albumData?.topalbums?.album || [];

    console.log(`Fetching top tracks (${period.key})...`);
    const trackData = await fetchLastFm('user.gettoptracks', { period: period.key, limit: '50' });
    results[`topTracks_${period.label}`] = trackData?.toptracks?.track || [];
  }

  // Weekly track chart
  console.log('Fetching weekly track chart...');
  const weeklyChart = await fetchLastFm('user.getweeklytrackchart', { limit: '100' });
  results.weeklyTrackChart = weeklyChart?.weeklytrackchart?.track || [];

  await fs.writeFile('./data/lastfm.json', JSON.stringify(results, null, 2));
  console.log('Last.fm data saved to data/lastfm.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
