// Pull Wildbow's Reddit comments from PullPush (the public Pushshift successor).
// Reddit blocks direct scraping, but PullPush mirrors full comment history and
// needs no auth — page `before` backwards through time, per subreddit.
//
// Scope = the subreddits we already have WoG from (derived from the repository's
// own reddit links). Output is raw; it still needs to go through the Haiku
// canon-classification pass (Reddit is banter-heavy) before anything is served.
//
// Usage: node pipeline/ingest-reddit.js [sub1,sub2,...]
import { mkdir, writeFile } from 'node:fs/promises';

const AUTHOR = 'Wildbow';
const API = 'https://api.pullpush.io/reddit/search/comment/';
const SUBS = (process.argv[2] || 'Parahumans,Weaverdice,whowouldwin,WormFanfic').split(',').map((s) => s.trim());
const PAGE = 100;
const UA = 'wooble-fan-archive/0.1 (personal WoG search project)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

async function fetchPage(sub, before) {
  const url = `${API}?author=${AUTHOR}&subreddit=${sub}&size=${PAGE}&sort=desc${before ? `&before=${before}` : ''}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return (await res.json()).data || [];
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

async function pullSub(sub) {
  const out = [];
  const seen = new Set();
  let before = null;
  while (true) {
    const page = await fetchPage(sub, before);
    if (!page.length) break;
    let added = 0;
    for (const c of page) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      added++;
    }
    before = page[page.length - 1].created_utc;
    if (!added) break;
    await sleep(700);
  }
  return out;
}

async function main() {
  const all = [];
  const seen = new Set();
  for (const sub of SUBS) {
    const got = await pullSub(sub);
    let added = 0;
    for (const c of got) { if (!seen.has(c.id)) { seen.add(c.id); all.push(c); added++; } }
    const dates = got.map((c) => c.created_utc).sort((a, b) => a - b);
    console.log(`r/${sub}: ${got.length} comments (${dates.length ? iso(dates[0]) + ' … ' + iso(dates.at(-1)) : '—'}), +${added} new`);
  }

  await mkdir('data/raw', { recursive: true });
  await writeFile('data/raw/reddit-wildbow.json', JSON.stringify(all, null, 2));

  const short = all.filter((c) => words(c.body) <= 8).length;
  const dates = all.map((c) => c.created_utc).sort((a, b) => a - b);
  console.log(`\nTOTAL ${all.length} comments across ${SUBS.length} subs, ${iso(dates[0])} … ${iso(dates.at(-1))}`);
  console.log(`short (<=8 words, rough banter proxy): ${short} (${Math.round((100 * short) / all.length)}%)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
