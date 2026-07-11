// Ingest Wildbow's serial "pages" — the static WordPress Pages on each serial
// blog that aren't chapters: the F.A.Q., Cast lists, About/premise pages, and
// Pale's "Extra Material" index. These are his authoritative out-of-story words,
// so they enter the corpus as Word of God (source 'Page') and are served
// directly — unlike reader comments, they need no relevance classification.
//
// The WordPress.com-hosted serials expose /pages over the public API. Ward
// (self-hosted parahumans.net) blocks its API (403) but serves page HTML, so its
// F.A.Q. is scraped from the rendered page like the Ward chapter scraper does.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'node-html-parser';
import { fetchJSON } from './fetch.js';
import { cleanContent, decodeEntities } from './clean.js';

const CORPUS_DIR = 'data/corpus';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'; // parahumans.net 403s non-browser agents
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
// Navigation / donation / image pages carry no Word of God.
const SKIP = /(^|\/)(table-of-contents|support|support-wildbow|gallery|donate)(\/|$)/i;

const pagesUrl = (site) =>
  `https://public-api.wordpress.com/wp/v2/sites/${site}/pages?per_page=100&_fields=id,date,slug,link,title,content`;

async function ingestWork(work) {
  let data;
  try { ({ data } = await fetchJSON(pagesUrl(work.site))); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const p of data) {
    const slug = p.slug || '';
    if (SKIP.test(slug)) continue;
    const text = cleanContent(p.content?.rendered ?? '');
    if (words(text) < 50) continue; // drop stubs
    const pageTitle = decodeEntities(p.title?.rendered ?? '').replace(/<[^>]+>/g, '').trim();
    out.push({
      id: `page:${work.slug}:${slug}`,
      work: work.title, workSlug: work.slug, type: 'WoG', source: 'Page',
      title: `${work.title} — ${pageTitle}`,
      text,
      url: p.link, date: (p.date ?? '').slice(0, 10), wordCount: words(text),
    });
  }
  return out;
}

const { works } = JSON.parse(await readFile('config/works.json', 'utf8'));
const records = [];
for (const w of works.filter((w) => w.api === 'wpcom')) {
  const recs = await ingestWork(w);
  records.push(...recs);
  process.stderr.write(`  ${w.title}: ${recs.length} pages — ${recs.map((r) => r.title.split('— ')[1]).join(', ')}\n`);
}

// Ward: API blocked, so scrape its HTML pages. Only the F.A.Q. carries WoG (its
// menu is just F.A.Q. / Table of Contents / Support); About & Cast 403 / absent.
const WARD_PAGES = [{ slug: 'f-a-q', title: 'F.A.Q.' }];
for (const wp of WARD_PAGES) {
  const url = `https://www.parahumans.net/${wp.slug}/`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const entry = parse(await res.text()).querySelector('.entry-content');
    const text = entry ? cleanContent(entry.innerHTML) : '';
    if (words(text) < 50) { process.stderr.write(`  Ward ${wp.slug}: too short/empty\n`); continue; }
    records.push({
      id: `page:ward:${wp.slug}`, work: 'Ward', workSlug: 'ward', type: 'WoG', source: 'Page',
      title: `Ward — ${wp.title}`, text, url, date: '', wordCount: words(text),
    });
    process.stderr.write(`  Ward: ${wp.title} (${words(text)}w, scraped HTML)\n`);
  } catch (e) { process.stderr.write(`  Ward ${wp.slug}: ${e.message}\n`); }
}

await mkdir(CORPUS_DIR, { recursive: true });
await writeFile(join(CORPUS_DIR, 'wog-pages.json'), JSON.stringify(records, null, 2));
console.log(`\n${records.length} serial pages, ${records.reduce((s, r) => s + r.wordCount, 0).toLocaleString()} words.`);
