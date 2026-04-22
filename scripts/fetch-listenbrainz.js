import { promises as fs } from 'fs';

const LISTENBRAINZ_TOKEN = process.env.LISTENBRAINZ_TOKEN;
const USER = 'emomert';
const BASE_URL = 'https://api.listenbrainz.org/1';

async function fetchLb(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Token ${LISTENBRAINZ_TOKEN}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`ListenBrainz ${endpoint} failed: ${res.status}`);
  return res.json();
}

async function main() {
  if (!LISTENBRAINZ_TOKEN) {
    console.error('LISTENBRAINZ_TOKEN is not set');
    process.exit(1);
  }

  const results = {};

  console.log('Fetching ListenBrainz listens...');
  const listens = await fetchLb(`/user/${USER}/listens?count=100`);
  results.listens = listens?.payload?.listens || [];

  console.log('Fetching ListenBrainz user stats (artists)...');
  try {
    const artistStats = await fetchLb(`/stats/user/${USER}/artists`);
    results.artistStats = artistStats?.payload || null;
  } catch (e) {
    console.warn('Artist stats fetch failed:', e.message);
    results.artistStats = null;
  }

  await fs.writeFile('./data/listenbrainz.json', JSON.stringify(results, null, 2));
  console.log('ListenBrainz data saved to data/listenbrainz.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
