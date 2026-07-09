// Pull Wildbow's Reddit *submissions* (self-posts) from PullPush — the companion
// to ingest-reddit.js, which only pulls his comments. His text posts include
// serial announcements, writing-process musings, and in-universe "PHO" roleplay.
//
// Two outputs, both to data/corpus/wog-reddit-posts.json:
//   * [PHO …] posts — Wildbow writing AS Parahumans Online forum users — are their
//     own served category ('PHO'), no relevance gate.
//   * every other self-post enters the SAME reddit WoG pipeline as his comments
//     (source 'Reddit', id wog:reddit:<id>), so build-pages canon-gates it. Their
//     classifier batches are written here as post-*.json (run AFTER convert-reddit,
//     which clears the batch dir).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const AUTHOR = 'Wildbow';
const API = 'https://api.pullpush.io/reddit/search/submission/';
const UA = 'wooble-fan-archive/0.1 (personal WoG search project)';
const RECORDS_OUT = 'data/corpus/wog-reddit-posts.json';
const BATCH_DIR = 'data/wog-batches';
const MIN_CHARS = 200; // a substantive self-post vs a bare link/announcement
const PER_BATCH = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const decode = (s) => String(s || '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x200B;/g, '').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);
const WORK = { Weaverdice: 'Weaverdice' }; // else Worm-verse
const isPHO = (title) => /\[\s*PHO/i.test(title);

async function fetchPage(before) {
  const url = `${API}?author=${AUTHOR}&size=100&sort=desc${before ? `&before=${before}` : ''}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return (await res.json()).data || [];
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(3000 * (attempt + 1));
    }
  }
}

async function pullAll() {
  const out = [];
  const seen = new Set();
  let before = null;
  while (true) {
    const page = await fetchPage(before);
    if (!page.length) break;
    let added = 0;
    for (const s of page) { if (!seen.has(s.id)) { seen.add(s.id); out.push(s); added++; } }
    before = page[page.length - 1].created_utc;
    if (!added || page.length < 100) break;
    await sleep(1500);
  }
  return out;
}

const subs = await pullAll();
const records = [];
let pho = 0, gated = 0;
for (const s of subs) {
  const body = decode(s.selftext);
  if (!s.is_self || body.length < MIN_CHARS || body === '[deleted]' || body === '[removed]') continue;
  const title = decode(s.title);
  const url = `https://www.reddit.com/r/${s.subreddit}/comments/${s.id}/`;
  const date = new Date(s.created_utc * 1000).toISOString().slice(0, 10);
  if (isPHO(title)) {
    records.push({
      id: `wog:pho:${s.id}`, type: 'WoG', source: 'PHO', work: 'Worm', workSlug: 'worm',
      title, chapterTitle: '', url, wogUrl: '', date, parentAuthor: '', subreddit: s.subreddit,
      question: '', text: body, wordCount: words(body),
    });
    pho++;
  } else {
    // Same shape as a reddit comment so it rides the existing canon-gate + tree.
    records.push({
      id: `wog:reddit:${s.id}`, type: 'WoG', source: 'Reddit', work: WORK[s.subreddit] || 'Worm',
      workSlug: (WORK[s.subreddit] || 'Worm').toLowerCase(),
      title: `WoG · ${clip(title || body, 70)}`, chapterTitle: '', url, wogUrl: '', date,
      parentAuthor: '', subreddit: s.subreddit, question: title, text: body, wordCount: words(body),
    });
    gated++;
  }
}
await mkdir('data/corpus', { recursive: true });
await writeFile(RECORDS_OUT, JSON.stringify(records, null, 2));

// Classifier batches for the unscored, non-PHO posts (PHO is served directly).
let scored = {};
try { scored = JSON.parse(await readFile('data/wog-scores.json', 'utf8')); } catch {}
const todo = records.filter((r) => r.source === 'Reddit' && !scored[r.id]);
await mkdir(BATCH_DIR, { recursive: true });
for (let i = 0; i < todo.length; i += PER_BATCH) {
  const batch = todo.slice(i, i + PER_BATCH).map((r) => ({
    id: r.id, asker: '', question: clip(r.question, 400), answer: clip(r.text, 800),
  }));
  await writeFile(join(BATCH_DIR, `post-${String(i / PER_BATCH).padStart(3, '0')}.json`), JSON.stringify(batch, null, 2));
}
console.log(`${records.length} self-posts kept: ${pho} PHO (served), ${gated} canon-gated.`);
console.log(`${todo.length} unscored → ${Math.ceil(todo.length / PER_BATCH)} post-batches in ${BATCH_DIR}/.`);
