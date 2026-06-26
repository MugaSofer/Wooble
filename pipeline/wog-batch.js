// Prepare batches of blog comments for WoG-relevance classification.
// Cache-aware: skips comments already scored in data/wog-scores.json, so runs
// are resumable and incremental (re-run to pick up whatever's left).
//
//   node pipeline/wog-batch.js [limit]   # limit = max comments this round (sampled across the unscored)
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CORPUS = 'data/corpus';
const BATCH_DIR = 'data/wog-batches';
const PARTS_DIR = 'data/wog-scores-parts';
const SCORES = 'data/wog-scores.json';
const SIZE = 50; // comments per batch / per Haiku agent

const limit = Number(process.argv[2]) || Infinity;

let scored = new Set();
try {
  scored = new Set(Object.keys(JSON.parse(await readFile(SCORES, 'utf8'))));
} catch {
  /* no cache yet */
}

const files = (await readdir(CORPUS)).filter((f) => /^wog-(worm|pact|twig|pale|claw|seek)\.json$/.test(f));
const comments = [];
for (const f of files) {
  for (const r of JSON.parse(await readFile(join(CORPUS, f), 'utf8'))) {
    if (r.type === 'WoG' && r.source === 'Comment' && r.wordCount > 0 && !scored.has(r.id)) comments.push(r);
  }
}

// When limited, sample evenly across the unscored set so the trial spans works.
let pick = comments;
if (limit < comments.length) {
  const step = comments.length / limit;
  pick = Array.from({ length: limit }, (_, i) => comments[Math.floor(i * step)]);
}

await rm(BATCH_DIR, { recursive: true, force: true });
await mkdir(BATCH_DIR, { recursive: true });
await mkdir(PARTS_DIR, { recursive: true });

let b = 0;
for (let i = 0; i < pick.length; i += SIZE) {
  const batch = pick.slice(i, i + SIZE).map((r) => ({
    id: r.id,
    asker: r.parentAuthor || '',
    question: (r.question || '').slice(0, 400),
    answer: r.text.slice(0, 800),
  }));
  await writeFile(join(BATCH_DIR, `batch-${String(b).padStart(3, '0')}.json`), JSON.stringify(batch));
  b++;
}

console.log(`${comments.length} unscored comments; batching ${pick.length} this round into ${b} files of up to ${SIZE}.`);
console.log(`batches: ${BATCH_DIR}  |  agents write scores to: ${PARTS_DIR}`);
