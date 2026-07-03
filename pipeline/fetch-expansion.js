// Fetch the expansion set — Wildbow-owned docs (PactDice, PRT Quest, WD extras,
// campaign sessions, Worm extras) discovered via Drive that the fan hubs never
// linked. Caches HTML exports to data/raw/gdocs, remembers misses.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RAW = 'data/raw/gdocs';
const MISS_FILE = 'data/raw/gdocs-miss.json';
const UA = 'wooble-fan-archive/0.1 (personal WoG search project)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let MISS = new Set();
try { MISS = new Set(JSON.parse(await readFile(MISS_FILE, 'utf8'))); } catch {}

async function fetchDoc(id) {
  const cache = join(RAW, id + '.html');
  if (existsSync(cache)) return 'cached';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://docs.google.com/document/d/${id}/export?format=html`, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      await writeFile(cache, html);
      await sleep(600);
      return Math.round(html.length / 1024) + 'kb';
    } catch (e) {
      if (attempt === 1) { MISS.add(id); await writeFile(MISS_FILE, JSON.stringify([...MISS], null, 2)); return 'MISS(' + e.message + ')'; }
      await sleep(2000);
    }
  }
}

const list = JSON.parse(await readFile('data/raw/gdocs-expansion.json', 'utf8'));
let ok = 0, miss = 0;
for (const d of list) {
  const r = await fetchDoc(d.id);
  if (String(r).startsWith('MISS')) miss++; else ok++;
  process.stderr.write(`  [${d.work}] ${d.title.slice(0, 38).padEnd(38)} ${r}\n`);
}
console.log(`\nExpansion fetch: ${ok} ok, ${miss} missed of ${list.length}.`);
