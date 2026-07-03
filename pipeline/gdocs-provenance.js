// Evidence-based provenance for the Weaverdice docs. Instead of a single-marker
// guess, gather ALL the signals the community's own indexes give us and record
// the evidence for each doc, then decide a tier from it:
//
//   canon      — a positive authorial signal: filed under a compilation's
//                "Official" heading, 🐗-marked, or referenced as a resource by a
//                doc we already know is WB's (the canon link-graph).
//   semicanon  — the 4 campaigns WB personally ran.
//   fanmade    — a positive fan signal: under a "Fan-Made"/"Fanon"/example
//                heading, a named community author, or an alt-system.
//   unknown    — no decisive evidence either way.
//
// Emits data/raw/gdocs-manifest.json (for convert-gdocs) AND a human-readable
// evidence table (data/gdocs-provenance.md + .csv) — the "spreadsheet of
// everything, with the evidence for each".
import { parse } from 'node-html-parser';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const RAW = 'data/raw/gdocs';
const HUBS = {
  '1fY4AgT6VQxv5nLDNPYeOZKTpLfydqWHzj6706G-NZIw': 'Welcome Doc',
  '17mZI-KMCupj_tUI2Z7vcwIbODGM_HymCl2RqohG3V08': 'The Vault',
  '1B5IJ6M0jl3Qavz5rgCiUhbhnf1LlS5brd54_zc5gysw': 'Classification hub',
};
const WIKI = 'data/raw/gdocs-wiki.html';
const CAMPAIGNS = new Set([
  '1L7XX00xrdLCHAiVzyX19G7sifIes2pfjMcHXUociFy4', '11Mj6LykIKPlkaMg3uDbjBKHEkBJVNvX8bH7RRp-IFes',
  '1E2Bd34dr6OkKE18046hHKr9PhEpmA23eeOIZr5hrGqU', '1vRKExsX2sR6ogK2FPwKelrZOFR_fMSfk9N8j3R3jqW4',
  '1a2kMh542q80YxKXBeIFci8CfuCL7pHUvL6x3noG2kJg', // WD Wichita — also a WB-run campaign
]);
// Docs verified via Google Drive to be owned by wildbowpig@gmail.com (Wildbow's
// account) — the ground-truth canon signal, ahead of any index heuristic.
let WB_OWNED = new Set();
try { WB_OWNED = new Set(readFileSync('data/raw/wb-owned.txt', 'utf8').split(/\s+/).filter(Boolean)); } catch {}
const EXCLUDE = new Set([
  '1zKgD3eLeIwqExynns2-aMGrkHFqYDVtVrX-n7Nfz3_U', '1M9MXimEZUryNuhd8cyhB0wPvJB6P_YxdzyoCXy9ojII',
  '1CNoeco_NkW8KD34uaeEif5f4D1BPodu_MeJgplAPZ5Y', '10PzJSdcwn0jfeb42BCWmnUw6ePha0cOkoV82MeH5U4o',
  '1Py-zQBE94hm8Iu0Oqoy_p_svALXYkKVpTiq-i7PwCwE',
]);
const BOAR = /🐗/;
const AUTHORED = /vaegrim|meme.?s\b|marsmissionguy|\btag.?s ideas|unis['’]|prim['’]s|grenade_beam/i;
const ALTSYS = /\bd20\b|weaverfate|weaverdice lite|\bwd lite\b|capes in the dark|level up gaming|sprg\b|skitterdice/i;
const FANSEC = /\bfanon\b|fan-made|fan made|\bfan\b|\(fan|example gen|premade|pregen|example game/i;
const RANK = { canon: 4, semicanon: 3, fanmade: 2, unknown: 1, excluded: 0 };
const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const cleanTitle = (t) => clean(t).replace(BOAR, '').replace(/^copy of\s*/i, '').trim();

// Extract { id, text, path } doc-links with their heading ancestor chain.
function harvest(html) {
  const body = parse(html).querySelector('body') || parse(html);
  const rows = [];
  const stack = [];
  for (const el of body.querySelectorAll('h1,h2,h3,h4,a')) {
    const mh = el.tagName.match(/^h([1-4])$/i);
    if (mh) {
      const lvl = +mh[1];
      while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
      stack.push({ lvl, txt: clean(el.text) });
      continue;
    }
    let href = el.getAttribute('href') || '';
    const q = href.match(/[?&]q=([^&]+)/); if (q) try { href = decodeURIComponent(q[1]); } catch {}
    const m = href.match(/document\/d\/([\w-]{20,})/) || href.match(/[?&]id=([\w-]{20,})/);
    if (!m) continue;
    rows.push({ id: m[1], text: clean(el.text), path: stack.map((s) => s.txt).filter(Boolean) });
  }
  return rows;
}
// Outbound doc-ids from any doc (for the reference link-graph).
function outbound(html) {
  const ids = new Set();
  for (const a of parse(html).querySelectorAll('a')) {
    let href = a.getAttribute('href') || '';
    const q = href.match(/[?&]q=([^&]+)/); if (q) try { href = decodeURIComponent(q[1]); } catch {}
    const m = href.match(/document\/d\/([\w-]{20,})/) || href.match(/[?&]id=([\w-]{20,})/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// --- gather hub appearances -------------------------------------------------
const appear = new Map(); // id -> [{ hub, path, text }]
const add = (id, rec) => { if (!appear.has(id)) appear.set(id, []); appear.get(id).push(rec); };
for (const [id, name] of Object.entries(HUBS)) {
  try { for (const r of harvest(readFileSync(`${RAW}/${id}.html`, 'utf8'))) add(r.id, { hub: name, path: r.path, text: r.text }); }
  catch { console.error('  (no cache for hub ' + name + ')'); }
}
try { for (const r of harvest(readFileSync(WIKI, 'utf8'))) add(r.id, { hub: 'Fandom wiki', path: r.path, text: r.text }); }
catch { console.error('  (no wiki cache)'); }
for (const id of Object.keys(HUBS)) appear.delete(id); // hubs aren't content

// best title per id (longest clean anchor text seen)
const titleById = new Map();
for (const [id, recs] of appear) {
  let best = '';
  for (const r of recs) { const t = cleanTitle(r.text); if (t && t.length > best.length) best = t; }
  titleById.set(id, best || id.slice(0, 12));
}

// --- reference link-graph from every cached doc -----------------------------
const linkGraph = new Map();
for (const f of readdirSync(RAW)) {
  if (!f.endsWith('.html')) continue;
  const id = f.replace(/\.html$/, '');
  try { linkGraph.set(id, outbound(readFileSync(`${RAW}/${f}`, 'utf8'))); } catch {}
}

// canon roots = docs with a hard authorial marker (Official section or 🐗)
const hasBoar = (id) => appear.get(id)?.some((r) => BOAR.test(r.text) || BOAR.test(r.path.join(' ')));
const inOfficial = (id) => appear.get(id)?.some((r) => r.path.some((h) => /^official$/i.test(h.trim())));
const canonRoots = [...appear.keys()].filter((id) => !EXCLUDE.has(id) && (hasBoar(id) || inOfficial(id)));
// what those roots reference → "cited as a resource by a doc we know is WB's"
const citedByCanon = new Map(); // id -> [rootTitle]
for (const root of canonRoots) {
  for (const t of linkGraph.get(root) || []) {
    if (t === root || !appear.has(t)) continue;
    if (!citedByCanon.has(t)) citedByCanon.set(t, []);
    if (!citedByCanon.get(t).includes(titleById.get(root))) citedByCanon.get(t).push(titleById.get(root));
  }
}

// --- decide tier + evidence per doc -----------------------------------------
const rows = [];
for (const [id, recs] of appear) {
  const ev = [];
  let tier;
  if (EXCLUDE.has(id)) { tier = 'excluded'; ev.push('excluded (alt-system / index)'); }
  else if (CAMPAIGNS.has(id)) { tier = 'semicanon'; ev.push('WB-run campaign'); }
  else {
    const owned = WB_OWNED.has(id);
    const boar = hasBoar(id), official = inOfficial(id);
    const fanRec = recs.find((r) => FANSEC.test(r.path.join(' / ')));
    const authorTxt = recs.map((r) => r.text).find((t) => AUTHORED.test(t) || ALTSYS.test(t));
    const cited = citedByCanon.get(id);
    if (owned) ev.push('owned by wildbowpig@gmail.com (Wildbow — verified via Drive)');
    if (boar) ev.push('🐗-marked in index');
    if (official) ev.push('Vault “Official” section');
    if (cited) ev.push('cited as resource by canon: ' + cited.slice(0, 2).join(', '));
    if (fanRec) ev.push('under fan heading: ' + fanRec.path.slice(-2).join(' › '));
    if (authorTxt) ev.push('community author / alt-system');
    const onWiki = recs.some((r) => r.hub === 'Fandom wiki'); if (onWiki) ev.push('listed on Fandom wiki');
    // Ownership is ground truth; index markers back it up. Anything not shown to
    // be WB's is treated as community (fan-made) — the safe direction.
    tier = owned || boar || official ? 'canon' : fanRec || authorTxt ? 'fanmade' : cited ? 'canon' : 'fanmade';
    if (!ev.length) ev.push('community (not in verified WB-owned set)');
  }
  rows.push({ id, title: titleById.get(id), tier, hub: recs[0]?.hub || '', section: recs[0]?.path.join(' / ') || '', evidence: ev.join('; ') });
}
rows.sort((a, b) => RANK[b.tier] - RANK[a.tier] || a.title.localeCompare(b.title));

// manifest for convert-gdocs (same shape as before)
writeFileSync('data/raw/gdocs-manifest.json', JSON.stringify(rows.map(({ id, title, tier, section, hub }) => ({ id, title, tier, section, hub })), null, 2));

// human-readable evidence table
const esc = (s) => String(s).replace(/\|/g, '\\|');
const md = ['# Weaverdice provenance — evidence per doc', '',
  '| Tier | Doc | Evidence |', '| --- | --- | --- |',
  ...rows.map((r) => `| ${r.tier} | ${esc(r.title)} | ${esc(r.evidence)} |`)].join('\n');
writeFileSync('data/gdocs-provenance.md', md);
const csv = ['tier,title,hub,section,evidence',
  ...rows.map((r) => [r.tier, r.title, r.hub, r.section, r.evidence].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
writeFileSync('data/gdocs-provenance.csv', csv);

const counts = {};
for (const r of rows) counts[r.tier] = (counts[r.tier] || 0) + 1;
console.log('provenance:', rows.length, 'docs →', JSON.stringify(counts));
console.log('canon roots:', canonRoots.length, '| docs cited-by-canon:', citedByCanon.size);
console.log('\nnewly canon-by-reference (no hard marker, but cited by a WB doc):');
for (const r of rows.filter((x) => x.tier === 'canon' && /cited as resource/.test(x.evidence) && !/🐗|Official/.test(x.evidence))) console.log('  ' + r.title.slice(0, 44).padEnd(44), '←', r.evidence.replace(/.*cited as resource by canon: /, ''));
console.log('\nstill unknown:', rows.filter((x) => x.tier === 'unknown').length);
