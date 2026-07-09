// Merge the per-batch serial-attribution parts the Haiku agents wrote into a
// single cache: data/wog-serial-tags.json (id -> [{serial, pct}]). Idempotent
// and additive, so it composes with re-runs (attr-batch skips already-tagged ids).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PARTS_DIR = 'data/wog-serial-tags-parts';
const OUT = 'data/wog-serial-tags.json';

let out = {};
try { out = JSON.parse(await readFile(OUT, 'utf8')); } catch {}

let files = [];
try { files = (await readdir(PARTS_DIR)).filter((f) => f.endsWith('.json')); } catch {
  console.error(`No ${PARTS_DIR} — nothing to merge.`); process.exit(1);
}

let added = 0, bad = 0;
for (const f of files) {
  let txt = (await readFile(join(PARTS_DIR, f), 'utf8')).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let arr;
  try { arr = JSON.parse(txt); } catch { bad++; console.error(`  ! could not parse ${f}`); continue; }
  for (const o of arr) {
    if (o && o.id && Array.isArray(o.tags)) {
      // keep only well-formed {serial, pct}, sorted high→low
      const tags = o.tags.filter((t) => t && t.serial && Number.isFinite(+t.pct)).map((t) => ({ serial: t.serial, pct: +t.pct })).sort((a, b) => b.pct - a.pct);
      out[o.id] = tags;
      added++;
    }
  }
}
await writeFile(OUT, JSON.stringify(out));
console.log(`Merged ${added} attributions${bad ? ` (${bad} unparseable files)` : ''} → ${Object.keys(out).length} total in ${OUT}.`);
