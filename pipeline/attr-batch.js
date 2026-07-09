// Prepare batches for SERIAL attribution of the mixed-subreddit Reddit WoG.
// r/Parahumans is the general Wildbow hub (any serial); r/Weaverdice doubles for
// PactDice. Both currently get a blanket work label, mislabeling ~40% of posts.
// We attribute only the SERVED (canon-category) records, and keep the full
// multi-serial confidence tag so crossover/universe-level WoG stays honest.
// Cache-aware: skips ids already in data/wog-serial-tags.json.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BATCH_DIR = 'data/attr-batches';
const SIZE = 50;
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s; };

const scores = JSON.parse(await readFile('data/wog-scores.json', 'utf8'));
let tagged = {};
try { tagged = JSON.parse(await readFile('data/wog-serial-tags.json', 'utf8')); } catch {}
const reddit = JSON.parse(await readFile('data/corpus/wog-reddit.json', 'utf8'));

// group -> candidate context is handled in the classifier prompt; here we just
// split the two mixed subs into their own batch streams.
const GROUPS = { para: 'Parahumans', wd: 'Weaverdice' };
const buckets = { para: [], wd: [] };
for (const r of reddit) {
  if (scores[r.id]?.category !== 'canon') continue;      // served (canon) only
  if (tagged[r.id]) continue;                            // already attributed
  if (r.subreddit === 'Parahumans') buckets.para.push(r);
  else if (r.subreddit === 'Weaverdice') buckets.wd.push(r);
}

await rm(BATCH_DIR, { recursive: true, force: true });
await mkdir(BATCH_DIR, { recursive: true });
for (const [g, recs] of Object.entries(buckets)) {
  for (let i = 0; i < recs.length; i += SIZE) {
    const batch = recs.slice(i, i + SIZE).map((r) => ({
      id: r.id, date: r.date, question: clip(r.question, 300), answer: clip(r.text, 700),
    }));
    await writeFile(join(BATCH_DIR, `${g}-${String(i / SIZE).padStart(3, '0')}.json`), JSON.stringify(batch, null, 2));
  }
  console.log(`${GROUPS[g]}: ${recs.length} canon records → ${Math.ceil(recs.length / SIZE)} ${g}-*.json batches`);
}
