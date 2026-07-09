// Ingest Wildbow's serial "pages" — the static WordPress Pages on each serial
// blog that aren't chapters: the F.A.Q., Cast lists, About/premise pages, and
// Pale's "Extra Material" index. These are his authoritative out-of-story words,
// so they enter the corpus as Word of God (source 'Page') and are served
// directly — unlike reader comments, they need no relevance classification.
//
// Only the WordPress.com-hosted serials expose /pages over the public API; Ward
// (self-hosted parahumans.net) blocks it (403) and would need an HTML scrape.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchJSON } from './fetch.js';
import { cleanContent, decodeEntities } from './clean.js';

const CORPUS_DIR = 'data/corpus';
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

await mkdir(CORPUS_DIR, { recursive: true });
await writeFile(join(CORPUS_DIR, 'wog-pages.json'), JSON.stringify(records, null, 2));
console.log(`\n${records.length} serial pages, ${records.reduce((s, r) => s + r.wordCount, 0).toLocaleString()} words.`);
