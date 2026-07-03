// Crawl Wildbow's interlinked Google Docs (Weaverdice / Pact Dice / PRT Quest …)
// from seed doc IDs. Each doc's HTML export preserves links + headings, so we
// extract its text AND its outbound doc links, then BFS-crawl the graph. Public
// docs only ("anyone with the link") — restricted ones just fail to export.
//
// Docs link to each other via google.com/url?q=<redirect> wrapping either
// docs.google.com/document/d/<ID> or drive.google.com/open?id=<ID>. The anchor
// text of the link is the target doc's name (the export has no <title>).
//
// Usage: node pipeline/ingest-gdocs.js <seedDocId> [seedDocId ...]
import { parse } from 'node-html-parser';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { htmlToText } from './clean.js';

const SEEDS = process.argv.slice(2);
const MAX_DOCS = Number(process.env.MAX_DOCS) || 80;
const RAW_DIR = 'data/raw/gdocs';
const UA = 'wooble-fan-archive/0.1 (personal WoG search project)';
// IDs we never fetch (fan alt-systems, campaign indexes, primers).
const BLOCK = new Set((process.env.BLOCK || '').split(',').map((s) => s.trim()).filter(Boolean));
// IDs we fetch for text but don't crawl outward from (WB-run campaigns, the
// mixed-content Vault) — keeps us from wandering into player sheets / fan docs.
const NOFOLLOW = new Set((process.env.NOFOLLOW || '').split(',').map((s) => s.trim()).filter(Boolean));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const exportUrl = (id) => `https://docs.google.com/document/d/${id}/export?format=html`;

// Outbound { id, text } links from a doc's HTML — unwrapping the google.com/url
// redirect and matching both /document/d/<ID> and drive open?id=<ID> forms.
function outboundLinks(html) {
  const out = [];
  const seen = new Set();
  for (const a of parse(html).querySelectorAll('a')) {
    let href = a.getAttribute('href') || '';
    const q = href.match(/[?&]q=([^&]+)/);
    if (q) try { href = decodeURIComponent(q[1]); } catch { /* keep raw */ }
    const m = href.match(/document\/d\/([\w-]{20,})/) || href.match(/[?&]id=([\w-]{20,})/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ id: m[1], text: (a.text || '').replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

async function fetchDoc(id) {
  const cache = join(RAW_DIR, id + '.html');
  if (existsSync(cache)) return readFile(cache, 'utf8');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(exportUrl(id), { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      await writeFile(cache, html);
      return html;
    } catch (e) {
      if (attempt === 2) return null;
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function main() {
  if (!SEEDS.length) { console.error('Give at least one seed doc ID.'); process.exit(1); }
  await mkdir(RAW_DIR, { recursive: true });
  const visited = new Set();
  const queue = [...SEEDS];
  const titleById = new Map();
  const docs = [];
  let misses = 0;
  while (queue.length && docs.length < MAX_DOCS) {
    const id = queue.shift();
    if (visited.has(id) || BLOCK.has(id)) continue;
    visited.add(id);
    const html = await fetchDoc(id);
    if (!html) { misses++; process.stderr.write(`  MISS ${id}\n`); continue; }
    const body = parse(html).querySelector('body');
    const text = htmlToText(body ? body.innerHTML : html).replace(/\s+/g, ' ').trim();
    if (words(text) < 5) { misses++; continue; } // not a real doc (folder/sheet/error)
    const out = outboundLinks(html);
    for (const l of out) if (l.text && !titleById.has(l.id)) titleById.set(l.id, l.text);
    const follow = !NOFOLLOW.has(id);
    const fresh = follow
      ? out.map((l) => l.id).filter((d) => !visited.has(d) && !queue.includes(d) && !BLOCK.has(d))
      : [];
    queue.push(...fresh);
    const title = titleById.get(id) || text.slice(0, 55);
    docs.push({ id, title, words: words(text), outLinks: out.length, leaf: !follow });
    process.stderr.write(`  ${docs.length}. ${title.slice(0, 46).padEnd(46)} ${words(text)}w, ${out.length} links (+${fresh.length}, queue ${queue.length})\n`);
    await sleep(500);
  }
  await writeFile('data/raw/gdocs-crawl.json', JSON.stringify(docs, null, 2));
  console.log(`\nCrawled ${docs.length} docs | ${misses} misses | ${queue.length} still queued (cap ${MAX_DOCS})`);
  console.log(`total ~${docs.reduce((s, d) => s + d.words, 0).toLocaleString()} words`);
}

main().catch((e) => { console.error(e); process.exit(1); });
