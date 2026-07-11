// check-fresh.js — is the corpus stale? Report what's been published PAST each
// source's newest corpus date, without pulling anything. Read-only, quick.
//
// Two cadences: WordPress serial chapters arrive ~weekly (Claw/Seek are live),
// but Reddit WoG is the fastest-moving source — Wildbow answers questions there
// continuously — so it's checked too. PullPush rate-limits hard, so Reddit uses
// just one request per endpoint (newest-first) and is a lower bound (the mirror
// lags real-time by days).
//
//   node pipeline/check-fresh.js
import { readFile } from 'node:fs/promises';

const UA = { 'User-Agent': 'wooble-fan-archive/0.1 (freshness check)' };
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const load = async (f) => JSON.parse(await readFile(`data/corpus/${f}`, 'utf8').catch(() => '[]'));
const maxDate = (recs) => recs.reduce((m, r) => (r.date && r.date > m ? r.date : m), '');
async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

let anyStale = false;

// --- 1. WordPress serials (chapters) ----------------------------------------
console.log('\n=== Serials (WordPress chapters) ===');
const { works } = JSON.parse(await readFile('config/works.json', 'utf8'));
for (const w of works) {
  const recs = await load(`${w.slug}.json`);
  const since = maxDate(recs);
  if (w.api !== 'wpcom') { console.log(`  ${w.title.padEnd(6)} corpus→${since || '—'}  (API not scraped: ${w.api}${w.site ? ', ' + w.site : ''} — check by hand)`); continue; }
  if (!since) { console.log(`  ${w.title.padEnd(6)} no corpus yet`); continue; }
  try {
    const posts = await getJson(`https://public-api.wordpress.com/wp/v2/sites/${w.site}/posts?after=${since}T23:59:59&per_page=100&orderby=date&order=asc&_fields=date,title,link`);
    if (posts.length) {
      anyStale = true;
      console.log(`  ${w.title.padEnd(6)} corpus→${since}  ⟶ ${posts.length} NEWER post${posts.length > 1 ? 's' : ''}:`);
      for (const p of posts.slice(0, 8)) console.log(`           ${p.date.slice(0, 10)}  ${(p.title?.rendered || '').replace(/<[^>]+>/g, '').slice(0, 50)}`);
      if (posts.length > 8) console.log(`           …and ${posts.length - 8} more`);
    } else {
      console.log(`  ${w.title.padEnd(6)} corpus→${since}  ✓ up to date`);
    }
  } catch (e) { console.log(`  ${w.title.padEnd(6)} corpus→${since}  (check failed: ${e.message})`); }
}

// --- 2. Reddit WoG (the fast-moving source) ---------------------------------
console.log('\n=== Reddit WoG (Wildbow, via PullPush — lower bound, mirror lags) ===');
const sinceReddit = maxDate([...(await load('wog-reddit.json')), ...(await load('wog-reddit-posts.json'))]);
const TRACKED = new Set(['Parahumans', 'Weaverdice', 'whowouldwin', 'WormFanfic']);
async function redditNewer(kind, api) {
  try {
    const items = (await getJson(`${api}?author=Wildbow&sort=desc&size=100`)).data || [];
    if (!items.length) { console.log(`  ${kind}: none returned`); return; }
    const newest = items[0].created_utc;
    const newer = items.filter((c) => iso(c.created_utc) > sinceReddit);
    const tracked = newer.filter((c) => TRACKED.has(c.subreddit));
    const subs = [...new Set(newer.map((c) => c.subreddit))];
    if (newer.length) {
      anyStale = anyStale || tracked.length > 0;
      console.log(`  ${kind}: corpus→${sinceReddit}, newest on PullPush ${iso(newest)} — ≥${newer.length} newer (${tracked.length} in tracked subs)`);
      console.log(`           subs seen: ${subs.slice(0, 12).join(', ')}${newer.length >= 100 ? ' (100-cap hit; likely more)' : ''}`);
    } else {
      console.log(`  ${kind}: corpus→${sinceReddit}  ✓ nothing newer on the mirror`);
    }
  } catch (e) { console.log(`  ${kind}: check failed (${e.message})`); }
}
await redditNewer('comments   ', 'https://api.pullpush.io/reddit/search/comment/');
await new Promise((r) => setTimeout(r, 1500)); // be gentle
await redditNewer('submissions', 'https://api.pullpush.io/reddit/search/submission/');

console.log(`\n${anyStale ? '→ New material available — worth a rebuild.' : '→ Everything looks current.'}\n`);
