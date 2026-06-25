// Ingest serials whose REST API is blocked (parahumans.net / Ward) by scraping
// the public HTML: read the table-of-contents page for chapter permalinks, then
// fetch and clean each chapter's entry-content. Dates come from the /YYYY/MM/DD/
// permalink. Glow-worm chapters are folded into Ward (its Arc 0).
//
// Usage: node pipeline/ingest-html.js ward [--limit N]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchText } from './fetch.js';
import { cleanContent, decodeEntities } from './clean.js';

const CORPUS_DIR = 'data/corpus';
const DEFAULT_TOC = '/table-of-contents/';

// Pull the body out of WordPress's entry-content div, balancing nested <div>s
// so we capture the whole chapter and stop exactly at its closing tag.
function extractEntryContent(html) {
  const open = html.match(/<div[^>]*class="[^"]*\bentry-content\b[^"]*"[^>]*>/i);
  if (!open) return '';
  const rest = html.slice(open.index + open[0].length);
  const tagRe = /<(\/?)div\b[^>]*>/gi;
  let depth = 1, m, end = rest.length;
  while ((m = tagRe.exec(rest))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      break;
    }
  }
  return rest.slice(0, end);
}

function extractTitle(html) {
  const m = html.match(/<h1[^>]*class="[^"]*\bentry-title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()) : '';
}

function dateFromPath(path) {
  const m = path.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

async function ingestWork(work, limit) {
  const base = `https://${work.site}`;
  const { text: toc } = await fetchText(base + (work.toc ?? DEFAULT_TOC));

  // Unique dated permalinks, ordered by date (path sorts date-first).
  let paths = [...new Set([...toc.matchAll(/href="(\/20\d\d\/\d\d\/\d\d\/[^"]+)"/g)].map((m) => m[1]))];
  paths.sort();
  if (limit) paths = paths.slice(0, limit);

  const records = [];
  for (const path of paths) {
    const url = base + path;
    const { text: html } = await fetchText(url);
    const text = cleanContent(extractEntryContent(html));
    records.push({
      id: `${work.slug}:${path.split('/').filter(Boolean).pop()}`,
      work: work.title,
      workSlug: work.slug,
      title: extractTitle(html) || path,
      url,
      date: dateFromPath(path),
      order: records.length,
      wordCount: text ? text.split(/\s+/).length : 0,
      categories: [],
      text,
    });
  }

  records.sort((a, b) => a.date.localeCompare(b.date));
  records.forEach((r, i) => (r.order = i));

  await mkdir(CORPUS_DIR, { recursive: true });
  await writeFile(join(CORPUS_DIR, `${work.slug}.json`), JSON.stringify(records, null, 2));
  return records;
}

async function main() {
  const argv = process.argv.slice(2);
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 0;
  const named = argv.filter((a, i) => !a.startsWith('--') && i !== (limitIdx >= 0 ? limitIdx + 1 : -1));

  const { works } = JSON.parse(await readFile('config/works.json', 'utf8'));
  const targets = works.filter((w) => w.api === 'html' && (named.length === 0 || named.includes(w.slug)));

  for (const work of targets) {
    process.stdout.write(`Scraping ${work.title}… `);
    const recs = await ingestWork(work, limit);
    const words = recs.reduce((n, r) => n + r.wordCount, 0);
    console.log(`${recs.length} chapters, ${words.toLocaleString()} words`);
    const sample = recs.find((r) => r.wordCount > 500) ?? recs[0];
    if (sample)
      console.log(`   e.g. "${sample.title}" (${sample.date}) — ${sample.wordCount} words\n        ${sample.url}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
