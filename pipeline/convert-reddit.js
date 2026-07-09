// Turn the enriched Reddit pull into WoG corpus records, and emit the same
// {id, asker, question, answer} batches the Haiku canon-classifier consumes.
// The question is the context we fetched (submission topic + the parent Wildbow
// is replying to) — essential for judging short replies. Output is staged at
// data/wog-reddit.json (NOT data/corpus) until it's classified and the serving
// path canon-gates it, so unclassified banter never reaches the index.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENRICHED = 'data/raw/reddit-wildbow-enriched.json';
const RECORDS_OUT = 'data/corpus/wog-reddit.json';
const BATCH_DIR = 'data/wog-batches';
const PARTS_DIR = 'data/wog-scores-parts';
const PER_BATCH = 50;

const decode = (s) => String(s || '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x200B;/g, '').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);
const WORK = { Weaverdice: 'Weaverdice' }; // else Worm-verse

async function main() {
  const raw = JSON.parse(await readFile(ENRICHED, 'utf8'));
  const records = [];
  for (const c of raw) {
    const body = decode(c.body);
    if (!body || body === '[deleted]' || body === '[removed]') continue;
    const work = WORK[c.subreddit] || 'Worm';
    const lid = String(c.link_id ?? '').replace(/^t3_/, '');
    const topic = decode(c.submissionTitle);
    const parent = decode(c.parentBody);
    const question = [topic, parent].filter(Boolean).join(' — ');
    records.push({
      id: `wog:reddit:${c.id}`,
      type: 'WoG',
      source: 'Reddit',
      work,
      workSlug: work.toLowerCase(),
      title: `WoG · ${clip(topic || body, 70)}`,
      chapterTitle: '',
      url: `https://www.reddit.com/r/${c.subreddit}/comments/${lid}/comment/${c.id}/`,
      wogUrl: '',
      date: new Date(c.created_utc * 1000).toISOString().slice(0, 10),
      parentAuthor: c.parentAuthor || '',
      subreddit: c.subreddit,
      question,
      text: body,
      wordCount: body.split(/\s+/).filter(Boolean).length,
    });
  }
  await writeFile(RECORDS_OUT, JSON.stringify(records, null, 2));

  // Batches for the classifier (skip ones already scored, so a re-run resumes).
  let scored = {};
  try { scored = JSON.parse(await readFile('data/wog-scores.json', 'utf8')); } catch { /* none */ }
  const todo = records.filter((r) => !scored[r.id]);
  await mkdir(BATCH_DIR, { recursive: true });
  await mkdir(PARTS_DIR, { recursive: true });
  // Clear only our own comment batches — the submissions pass writes post-*.json
  // into the same dir and must not be wiped here.
  for (const f of await readdir(BATCH_DIR)) if (/^batch-\d+\.json$/.test(f)) await rm(join(BATCH_DIR, f));
  let n = 0;
  for (let i = 0; i < todo.length; i += PER_BATCH) {
    const batch = todo.slice(i, i + PER_BATCH).map((r) => ({
      id: r.id,
      asker: r.parentAuthor,
      question: clip(r.question, 400),
      answer: clip(r.text, 800),
    }));
    await writeFile(join(BATCH_DIR, `batch-${String(n).padStart(3, '0')}.json`), JSON.stringify(batch, null, 2));
    n++;
  }
  console.log(`Wrote ${records.length} records to ${RECORDS_OUT}.`);
  console.log(`${todo.length} unscored → ${n} batches of ${PER_BATCH} in ${BATCH_DIR}/.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
