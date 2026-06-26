// Merge the per-batch score files the classifier agents wrote into the single
// cache data/wog-scores.json (id -> {category, significance, wog_pct}).
// Idempotent and additive, so it composes with incremental runs.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PARTS_DIR = 'data/wog-scores-parts';
const SCORES = 'data/wog-scores.json';

let out = {};
try {
  out = JSON.parse(await readFile(SCORES, 'utf8'));
} catch {
  /* fresh */
}

let files = [];
try {
  files = (await readdir(PARTS_DIR)).filter((f) => f.endsWith('.json'));
} catch {
  console.error(`No ${PARTS_DIR} — nothing to merge.`);
  process.exit(1);
}

let added = 0, unparseable = 0;
for (const f of files) {
  let txt = await readFile(join(PARTS_DIR, f), 'utf8').then((t) => t.trim());
  txt = txt.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim(); // tolerate code fences
  let arr;
  try {
    arr = JSON.parse(txt);
  } catch {
    unparseable++;
    console.error(`  ! could not parse ${f}`);
    continue;
  }
  for (const o of arr) {
    if (o && o.id) {
      out[o.id] = { category: o.category, significance: o.significance, wog_pct: o.wog_pct };
      added++;
    }
  }
}

await writeFile(SCORES, JSON.stringify(out));
console.log(`Merged ${added} scores${unparseable ? ` (${unparseable} unparseable files)` : ''} → ${Object.keys(out).length} total in ${SCORES}.`);
