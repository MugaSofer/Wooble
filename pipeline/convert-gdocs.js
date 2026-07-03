// Turn the tiered Google-Docs manifest into corpus records for Wooble.
//
// Each doc's HTML export is split at its headings (h1–h3, each carries an
// id="h.xxxx"), so every section becomes its own record that deep-links to that
// exact heading — landing a search on the right skill/rule, not the top of a
// 24k-word doc. Records carry the provenance `tier` from the manifest so the UI
// can badge canon / semi-canon / fan-made / unknown.
//
// Undated (WD docs have no publish date). type:'Reference', work:'Weaverdice'.
import { parse } from 'node-html-parser';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RAW_DIR = 'data/raw/gdocs';
const UA = 'wooble-fan-archive/0.1 (personal WoG search project)';
const MIN_SECTION_WORDS = 25; // drop pure-parent headings / stubs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// Docs that fail to export (restricted / deleted / Sheets) are remembered so
// re-runs skip them instead of retrying dead links every time.
const MISS_FILE = 'data/raw/gdocs-miss.json';
let MISS = new Set();
try { MISS = new Set(JSON.parse(await readFile(MISS_FILE, 'utf8'))); } catch { /* first run */ }
const saveMiss = () => writeFile(MISS_FILE, JSON.stringify([...MISS], null, 2));

async function fetchDoc(id) {
  const cache = join(RAW_DIR, id + '.html');
  if (existsSync(cache)) return readFile(cache, 'utf8');
  if (MISS.has(id)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `https://docs.google.com/document/d/${id}/export?format=html`;
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      await writeFile(cache, html);
      await sleep(500);
      return html;
    } catch (e) {
      if (attempt === 1) { MISS.add(id); await saveMiss(); return null; }
      await sleep(1500);
    }
  }
}

// Split a doc body into { anchor, heading, text } sections at h1–h3 boundaries.
// Leaf text comes from p/li elements (tables in gdocs are td>p, so their prose
// is captured as paragraphs — no double counting from selecting the table too).
function sections(html, docTitle) {
  // Drop inline base64 image/font data — it's the bulk of a big export's bytes
  // (the PactDice doc is 77MB of it) and carries no searchable text.
  html = html.replace(/ (?:src|href)="data:[^"]*"/g, '');
  const body = parse(html).querySelector('body');
  if (!body) return [];
  // Ids whose element is empty. A "-N"-suffixed heading whose base points at an
  // empty element is a mis-styled paragraph-run: Google clustered several
  // paragraph-headings onto one stub bookmark (h.xxx + h.xxx-1/-2/-3…), and those
  // variants don't resolve as #heading deep-links (they fall to the doc top). A
  // "-N" heading whose base is a *real* heading (two headings colliding on one
  // bookmark, e.g. BRUTE's "Plate"/"Ogre") is a genuine heading — left alone.
  const emptyId = new Set();
  for (const el of body.querySelectorAll('[id]')) if (!clean(el.text)) emptyId.add(el.getAttribute('id'));
  const out = [];
  let cur = { anchor: '', heading: docTitle, parts: [] };
  for (const el of body.querySelectorAll('h1,h2,h3,p,li')) {
    const t = clean(el.text);
    const id = el.getAttribute('id') || '';
    const sfx = id.match(/^(.*)-\d+$/);
    const degenerate = sfx && emptyId.has(sfx[1]);
    // A genuine heading is short (a paragraph styled as a heading is over-long)
    // and not a degenerate clustered anchor. Fold anything else into the body.
    const isHeading = /^h[1-3]$/i.test(el.tagName) && t && t.length <= 100 && !degenerate;
    if (isHeading) {
      if (cur.parts.length) out.push(cur);
      cur = { anchor: id, heading: t, parts: [] };
    } else if (t) {
      cur.parts.push(t);
    }
  }
  if (cur.parts.length) out.push(cur);
  return out.map((s) => ({ anchor: s.anchor, heading: s.heading, text: s.parts.join('\n\n') }));
}

async function main() {
  const manifest = JSON.parse(await readFile('data/raw/gdocs-manifest.json', 'utf8')).filter((m) => m.tier !== 'excluded');
  // The expansion set = WB-owned docs (PactDice, PRT Quest, WD extras, Worm
  // extras) discovered via Drive, each carrying its own `work` collection. An
  // expansion entry OVERRIDES a manifest entry with the same id (e.g. the PRT
  // Quest docs move out of Weaverdice into their own semi-canon collection).
  let expansion = [];
  try { expansion = JSON.parse(await readFile('data/raw/gdocs-expansion.json', 'utf8')); } catch {}
  const byId = new Map();
  for (const m of manifest) byId.set(m.id, m);
  for (const e of expansion) byId.set(e.id, e);
  const wanted = [...byId.values()];
  await mkdir(RAW_DIR, { recursive: true });
  const records = [];
  const perTier = {};
  let fetched = 0, missed = 0, docsUsed = 0;

  for (const doc of wanted) {
    const html = await fetchDoc(doc.id);
    if (!html) { missed++; process.stderr.write(`  MISS ${doc.title}\n`); continue; }
    if (!existsSync(join(RAW_DIR, doc.id + '.html'))) fetched++;
    const secs = sections(html, doc.title);
    const kept = secs.filter((s) => words(s.text) >= MIN_SECTION_WORDS);
    // A doc with no substantial split (short doc, no headings) → one whole-doc record.
    const use = kept.length ? kept : (secs.length ? [{ anchor: '', heading: doc.title, text: secs.map((s) => s.text).join('\n\n') }] : []);
    if (!use.length) { missed++; continue; }
    docsUsed++;
    const work = doc.work || 'Weaverdice';
    const workSlug = work.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    use.forEach((s, i) => {
      const base = `https://docs.google.com/document/d/${doc.id}/edit`;
      records.push({
        id: `wd:${doc.id}:${i}`,
        work,
        workSlug,
        type: 'Reference',
        tier: doc.tier,
        docTitle: doc.title,
        title: use.length > 1 && s.heading && s.heading !== doc.title ? `${doc.title} — ${s.heading}` : doc.title,
        heading: s.heading,
        text: s.text,
        url: s.anchor ? `${base}#heading=${s.anchor}` : base,
        date: '',
        wordCount: words(s.text),
      });
    });
    perTier[doc.tier] = (perTier[doc.tier] || 0) + 1;
  }

  await mkdir('data/corpus', { recursive: true });
  await writeFile('data/corpus/weaverdice.json', JSON.stringify(records, null, 2));
  console.log(`\n${records.length} records from ${docsUsed} docs (${fetched} newly fetched, ${missed} missed).`);
  console.log('docs per tier:', JSON.stringify(perTier));
  console.log('total words:', records.reduce((s, r) => s + r.wordCount, 0).toLocaleString());
}

main().catch((e) => { console.error(e); process.exit(1); });
