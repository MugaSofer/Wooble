// Attach parent context to the pulled Reddit comments, so the classifier (and
// the reader) can see what Wildbow was replying to — a bare "Yes." is only
// judgeable as WoG against its question. PullPush exposes each comment's
// parent_id / link_id; we batch-fetch those parents (comments + submissions) by
// id (100 per request) and fold them in.
//
// Reads data/raw/reddit-wildbow.json, writes data/raw/reddit-wildbow-enriched.json.
import { readFile, writeFile } from 'node:fs/promises';

const API_C = 'https://api.pullpush.io/reddit/search/comment/';
const API_S = 'https://api.pullpush.io/reddit/search/submission/';
const UA = { 'User-Agent': 'wooble-fan-archive/0.1 (personal WoG search project)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).data || [];
    } catch (e) {
      if (a === 4) throw e;
      await sleep(2000 * (a + 1));
    }
  }
}

async function fetchByIds(api, ids) {
  const map = new Map();
  const arr = [...ids];
  for (let i = 0; i < arr.length; i += 100) {
    const data = await fetchJson(api + '?ids=' + arr.slice(i, i + 100).join(','));
    for (const x of data) map.set(x.id, x);
    process.stderr.write(`  ${Math.min(i + 100, arr.length)}/${arr.length}\n`);
    await sleep(700);
  }
  return map;
}

async function main() {
  const recs = JSON.parse(await readFile('data/raw/reddit-wildbow.json', 'utf8'));
  const parentCommentIds = new Set();
  const submissionIds = new Set();
  for (const c of recs) {
    const pid = String(c.parent_id ?? ''), lid = String(c.link_id ?? '');
    if (pid.startsWith('t1_')) parentCommentIds.add(pid.slice(3));
    if (pid.startsWith('t3_')) submissionIds.add(pid.slice(3));
    if (lid.startsWith('t3_')) submissionIds.add(lid.slice(3));
  }
  console.log(`${recs.length} comments | ${parentCommentIds.size} parent comments + ${submissionIds.size} submissions to fetch`);

  const parents = await fetchByIds(API_C, parentCommentIds);
  const subs = await fetchByIds(API_S, submissionIds);

  let withCtx = 0;
  for (const c of recs) {
    const pid = String(c.parent_id ?? ''), lid = String(c.link_id ?? '');
    c.submissionTitle = (lid.startsWith('t3_') ? subs.get(lid.slice(3))?.title : '') || '';
    if (pid.startsWith('t1_')) {
      const p = parents.get(pid.slice(3));
      c.parentBody = p?.body || '';
      c.parentAuthor = p?.author || '';
    } else if (pid.startsWith('t3_')) {
      const s = subs.get(pid.slice(3));
      c.parentBody = (s?.selftext || '').slice(0, 2000);
      c.parentAuthor = s?.author || '';
    } else {
      c.parentBody = '';
      c.parentAuthor = '';
    }
    if (c.submissionTitle || c.parentBody) withCtx++;
  }

  await writeFile('data/raw/reddit-wildbow-enriched.json', JSON.stringify(recs, null, 2));
  console.log(`Enriched ${withCtx}/${recs.length} with context → data/raw/reddit-wildbow-enriched.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
