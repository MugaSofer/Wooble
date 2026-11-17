// Classify blank-attribution quotes from the SpaceBattles WoG thread.
//
// Quotes pasted into the thread from elsewhere (RPG.net, blog comments, chat
// logs) lose XenForo's "X said:" tag, so ingest-spacebattles.js can't tell
// Wildbow's words from a fan's. It dumps them to data/sb-unattr-candidates.json;
// this script batches the ones not already in the corpus (most pasted blog
// comments are — we scraped those directly — and some are story excerpts) for
// a Haiku pass, then merges the verdicts into data/sb-unattr-verdicts.json,
// which the ingester uses to admit the Wildbow ones.
//
//   node pipeline/sb-unattr-batch.js batch   # → data/sb-unattr-batches/*.json
//   (one Haiku agent per batch writes data/sb-unattr-parts/<same name>)
//   (hand review: data/sb-unattr-parts/review.json — sorts after batch-*, so it wins)
//   node pipeline/sb-unattr-batch.js merge   # parts → verdicts; then re-run the ingester
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CANDIDATES = 'data/sb-unattr-candidates.json';
const VERDICTS = 'data/sb-unattr-verdicts.json';
const BATCH_DIR = 'data/sb-unattr-batches';
const PART_DIR = 'data/sb-unattr-parts';
const CORPUS = 'data/corpus';
const PER = 25;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function loadJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

async function batch() {
  const cands = await loadJson(CANDIDATES, null);
  if (!cands) throw new Error(`${CANDIDATES} missing — run pipeline/ingest-spacebattles.js first`);
  const verdicts = await loadJson(VERDICTS, {});
  const candIds = new Set(cands.map((c) => c.id));

  // Everything already in the corpus (story text and WoG alike), minus the
  // candidates themselves once admitted.
  const parts = [];
  for (const f of await readdir(CORPUS)) {
    for (const r of JSON.parse(await readFile(join(CORPUS, f), 'utf8'))) {
      if (!candIds.has(r.id)) parts.push(norm(r.text));
    }
  }
  const blob = parts.join(' | ');
  // Covered = at least 2 of 3 probe windows (start/middle/end) found verbatim.
  const covered = (text) => {
    const n = norm(text);
    const mid = Math.floor(n.length / 2);
    const probes = [n.slice(0, 50), n.slice(mid, mid + 50), n.slice(-50)];
    return probes.filter((p) => blob.includes(p)).length >= 2;
  };

  let nCovered = 0, nDone = 0, nShort = 0;
  const todo = [];
  for (const c of cands) {
    if (verdicts[c.id]) { nDone++; continue; }
    if (norm(c.text).length < 30) { nShort++; continue; }
    if (covered(c.text)) { nCovered++; continue; }
    todo.push({
      id: c.id,
      poster: c.poster,
      label: c.label,
      question: c.question.slice(0, 1500),
      source: c.source,
      text: c.text.slice(0, 6000),
    });
  }

  await rm(BATCH_DIR, { recursive: true, force: true });
  await rm(PART_DIR, { recursive: true, force: true });
  await mkdir(BATCH_DIR, { recursive: true });
  await mkdir(PART_DIR, { recursive: true });
  let n = 0;
  for (let i = 0; i < todo.length; i += PER) {
    await writeFile(join(BATCH_DIR, `batch-${String(n).padStart(2, '0')}.json`), JSON.stringify(todo.slice(i, i + PER), null, 2));
    n++;
  }
  console.log(`${cands.length} candidates: ${nDone} already judged, ${nCovered} already in corpus, ${nShort} too short.`);
  console.log(`Wrote ${n} batches (${todo.length} quotes) to ${BATCH_DIR}/; parts go to ${PART_DIR}/.`);
}

async function merge() {
  const verdicts = await loadJson(VERDICTS, {});
  let added = 0, yes = 0;
  for (const f of (await readdir(PART_DIR)).filter((f) => f.endsWith('.json'))) {
    for (const v of JSON.parse(await readFile(join(PART_DIR, f), 'utf8'))) {
      if (!v.id || typeof v.wildbow !== 'boolean') throw new Error(`bad verdict in ${f}: ${JSON.stringify(v)}`);
      // swap: Wildbow's reply is the nested quote and the top-level text is the
      // fan's question (inverted paste) — the ingester flips them.
      verdicts[v.id] = { wildbow: v.wildbow, kind: v.kind || '', ...(v.swap ? { swap: true } : {}) };
      added++;
      if (v.wildbow) yes++;
    }
  }
  const sorted = Object.fromEntries(Object.entries(verdicts).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(VERDICTS, JSON.stringify(sorted, null, 1) + '\n');
  console.log(`Merged ${added} verdicts (${yes} Wildbow) → ${VERDICTS} (${Object.keys(sorted).length} total).`);
}

const mode = process.argv[2];
if (mode === 'batch') await batch();
else if (mode === 'merge') await merge();
else { console.error('usage: node pipeline/sb-unattr-batch.js batch|merge'); process.exit(1); }
