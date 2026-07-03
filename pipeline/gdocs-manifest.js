// Build a tiered manifest of Weaverdice Google Docs by harvesting the community
// index/hub docs (Welcome Doc, the Vault, the classification hub, the Fandom wiki)
// and assigning each linked doc a provenance tier from the markers those indexes
// use: 🐗 / "Official" heading → official, named-author / alt-system → fan,
// the WB-run campaigns → semi-canon, everything else → community (unverified).
//
// Output: data/raw/gdocs-manifest.json  [{ id, title, tier, section, hub }]
// Fetching + record-building happen in later steps; this is just the plan.
import { parse } from 'node-html-parser';
import { readFileSync, writeFileSync } from 'node:fs';

const RAW = 'data/raw/gdocs';
// Index docs we trust to *describe* provenance (id → friendly hub name).
const HUBS = {
  '1fY4AgT6VQxv5nLDNPYeOZKTpLfydqWHzj6706G-NZIw': 'Welcome Doc',
  '17mZI-KMCupj_tUI2Z7vcwIbODGM_HymCl2RqohG3V08': 'The Vault',
  '1B5IJ6M0jl3Qavz5rgCiUhbhnf1LlS5brd54_zc5gysw': 'Classification hub',
};
const WIKI = 'data/raw/gdocs-wiki.html';

// WB-run campaigns → semi-canon (he ran them canon-compatible).
const CAMPAIGNS = new Set([
  '1L7XX00xrdLCHAiVzyX19G7sifIes2pfjMcHXUociFy4', // Oakland
  '11Mj6LykIKPlkaMg3uDbjBKHEkBJVNvX8bH7RRp-IFes', // Helena
  '1E2Bd34dr6OkKE18046hHKr9PhEpmA23eeOIZr5hrGqU', // Lausanne
  '1vRKExsX2sR6ogK2FPwKelrZOFR_fMSfk9N8j3R3jqW4', // Lincoln
]);
// Alt game-systems / primers / indexes we agreed to leave out entirely (not
// WB-world reference — separate rulesets or link-lists). Tier 'excluded'.
const EXCLUDE = new Set([
  '1zKgD3eLeIwqExynns2-aMGrkHFqYDVtVrX-n7Nfz3_U', // campaign list
  '1M9MXimEZUryNuhd8cyhB0wPvJB6P_YxdzyoCXy9ojII', // Skitterdice
  '1CNoeco_NkW8KD34uaeEif5f4D1BPodu_MeJgplAPZ5Y', // WeaverFate
  '10PzJSdcwn0jfeb42BCWmnUw6ePha0cOkoV82MeH5U4o', // Weaverdice d20
  '1Py-zQBE94hm8Iu0Oqoy_p_svALXYkKVpTiq-i7PwCwE', // Guide for Newcomers
]);

const BOAR = /🐗|🐗/;
const AUTHORED = /vaegrim|meme.?s\b|marsmissionguy|\btag.?s ideas|unis['’]|prim['’]s|grenade_beam/i;
const ALTSYS = /\bd20\b|weaverfate|weaverdice lite|\bwd lite\b|capes in the dark|level up gaming|sprg\b|skitterdice/i;
const FANMARK = /\bfanon\b|fan-made|fan made|\bfan\b|\(fan/i;
const EXAMPLES = /example gen|premade|pregen|example game/i; // sample chars/campaigns → community
const RANK = { canon: 4, semicanon: 3, fanmade: 2, unknown: 1, excluded: 0 };

// Tier a link from its own text + its full heading ANCESTOR PATH, so a doc under
// "Fan-Made Essentials › 3.0 Equipment" or "Example Gens/Premades" inherits the
// section's provenance even when its own row carries no marker.
function tierOf(text, path) {
  const pathStr = path.join(' / ');
  if (BOAR.test(text) || BOAR.test(pathStr)) return 'canon';
  if (path.some((h) => /^official$/i.test(h.trim()))) return 'canon';
  if (ALTSYS.test(text)) return 'fanmade';
  if (AUTHORED.test(text)) return 'fanmade';
  if (FANMARK.test(pathStr) || EXAMPLES.test(pathStr) || /\(fan|fanon|fan version/i.test(text)) return 'fanmade';
  return 'unknown';
}

// Harvest { id, text, path } for every doc-link, tracking the heading stack so
// each link knows its full ancestor chain (h1 › h2 › h3), not just the nearest.
function harvest(html) {
  const body = parse(html).querySelector('body') || parse(html);
  const rows = [];
  const stack = [];
  for (const el of body.querySelectorAll('h1,h2,h3,h4,a')) {
    const mh = el.tagName.match(/^h([1-4])$/i);
    if (mh) {
      const lvl = +mh[1];
      while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
      stack.push({ lvl, txt: (el.text || '').replace(/\s+/g, ' ').trim() });
      continue;
    }
    let href = el.getAttribute('href') || '';
    const q = href.match(/[?&]q=([^&]+)/); if (q) try { href = decodeURIComponent(q[1]); } catch {}
    const m = href.match(/document\/d\/([\w-]{20,})/) || href.match(/[?&]id=([\w-]{20,})/);
    if (!m) continue;
    rows.push({ id: m[1], text: (el.text || '').replace(/\s+/g, ' ').trim(), path: stack.map((s) => s.txt).filter(Boolean) });
  }
  return rows;
}

const cleanTitle = (t) => t.replace(BOAR, '').replace(/\s+/g, ' ').trim().replace(/^copy of\s*/i, '');

const byId = new Map();
function consider(row, hub) {
  const { id } = row;
  const section = row.path.join(' / ');
  let tier = CAMPAIGNS.has(id) ? 'semicanon' : EXCLUDE.has(id) ? 'excluded' : tierOf(row.text, row.path);
  const title = cleanTitle(row.text);
  const prev = byId.get(id);
  if (!prev) { byId.set(id, { id, title, tier, section, hub }); return; }
  // keep the strongest tier; prefer a longer, non-generic title
  if (RANK[tier] > RANK[prev.tier]) { prev.tier = tier; prev.section = section; prev.hub = hub; }
  if (title && title.length > prev.title.length && !/^copy of/i.test(title)) prev.title = title;
}

for (const [id, name] of Object.entries(HUBS)) {
  let html; try { html = readFileSync(`${RAW}/${id}.html`, 'utf8'); } catch { console.error('  (no cache for hub ' + name + ')'); continue; }
  for (const row of harvest(html)) consider(row, name);
}
try { for (const row of harvest(readFileSync(WIKI, 'utf8'))) consider(row, 'Fandom wiki'); } catch { console.error('  (no wiki cache)'); }

// Drop the hub docs themselves from the manifest (they're indexes, not content).
for (const id of Object.keys(HUBS)) byId.delete(id);

const manifest = [...byId.values()].sort((a, b) => RANK[b.tier] - RANK[a.tier] || a.title.localeCompare(b.title));
writeFileSync('data/raw/gdocs-manifest.json', JSON.stringify(manifest, null, 2));

const counts = {};
for (const m of manifest) counts[m.tier] = (counts[m.tier] || 0) + 1;
console.log('manifest:', manifest.length, 'docs →', JSON.stringify(counts));
for (const tier of ['canon', 'semicanon', 'fanmade', 'unknown', 'excluded']) {
  const rows = manifest.filter((m) => m.tier === tier);
  console.log(`\n=== ${tier.toUpperCase()} (${rows.length}) ===`);
  for (const m of rows.slice(0, tier === 'unknown' ? 999 : 40)) console.log('  ' + m.title.slice(0, 52));
}
