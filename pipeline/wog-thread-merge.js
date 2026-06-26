// Merge the Sonnet attribution parts into a proposed patch, validating each
// result against the source context before anything is applied. A "source"
// verdict is only accepted if its URL actually appears in that entry's
// transcript (guards against a hallucinated link). Writes the patch to
// data/wog-thread-fixes.json and prints a review digest for a human to eyeball.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PART_DIR = 'data/wog-thread-parts';
const CONTEXT = 'data/wog-thread-context.json';
const OUT = 'data/wog-thread-fixes.json';

async function main() {
  const ctx = new Map(JSON.parse(await readFile(CONTEXT, 'utf8')).map((c) => [c.id, c]));
  const verdicts = [];
  for (const f of (await readdir(PART_DIR)).filter((f) => f.endsWith('.json')).sort()) {
    verdicts.push(...JSON.parse(await readFile(join(PART_DIR, f), 'utf8')));
  }

  // A URL we won't accept as a source: a dead/expiring Discord CDN attachment or
  // a malformed host (same rule the parser uses). These stay thread-only.
  const badUrl = (u) => {
    const m = /^https?:\/\/([^/?#]*)/i.exec(u || '');
    if (!m) return true;
    const host = m[1];
    return /\s/.test(host) || !host.includes('.') || /(^|\.)cdn\.discordapp\.com$/i.test(host);
  };

  // Additive: keep attributions from earlier passes and add the new ones.
  let patch = {};
  try { patch = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first pass */ }
  const preexisting = Object.keys(patch).length;
  const accepted = [];
  const flagged = [];
  let threadOnly = 0;
  const seen = new Set();
  for (const v of verdicts) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const c = ctx.get(v.id);
    if (v.verdict !== 'source') { threadOnly++; continue; }
    // Accept only if the URL is real (present in the transcript we showed it)
    // and usable (not a dead/malformed link).
    if (!v.url || !c || !c.transcript.includes(v.url)) { flagged.push({ ...v, reason: 'url not in transcript' }); continue; }
    if (badUrl(v.url)) { flagged.push({ ...v, reason: 'dead/unusable link → stays thread-only' }); continue; }
    patch[v.id] = { source: v.sourceLabel, url: v.url };
    accepted.push({ ...v, label: c.label });
  }

  await writeFile(OUT, JSON.stringify(patch, null, 2));

  const missing = [...ctx.keys()].filter((id) => !seen.has(id));
  const byLabel = {};
  accepted.forEach((a) => (byLabel[a.sourceLabel] = (byLabel[a.sourceLabel] || 0) + 1));

  console.log(`\n=== ${verdicts.length} verdicts | ${accepted.length} attributed | ${threadOnly} stay thread-only | ${flagged.length} flagged | ${missing.length} missing ===`);
  console.log('attributed by source:', JSON.stringify(byLabel));
  console.log('\n--- proposed attributions (eyeball these) ---');
  for (const a of accepted) {
    console.log(`[${a.sourceLabel}] ${a.label.slice(0, 55) || '(no label)'}`);
    console.log(`   ${a.url}`);
    console.log(`   why: ${a.why}`);
  }
  if (flagged.length) {
    console.log('\n--- FLAGGED (NOT applied, stay thread-only) ---');
    flagged.forEach((v) => console.log(`   ${v.id} [${v.reason}] -> ${v.url || '(no url)'} | ${v.why}`));
  }
  if (missing.length) console.log('\nMISSING ids (no verdict):', missing);
  console.log(`\nPatch written to ${OUT} (${Object.keys(patch).length} entries: ${preexisting} prior + ${accepted.length} new).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
