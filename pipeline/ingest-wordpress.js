// Ingest Wildbow serials from their WordPress APIs into a cleaned corpus.
//
// Usage:
//   node pipeline/ingest-wordpress.js                 # all working WP sources
//   node pipeline/ingest-wordpress.js worm            # one work
//   node pipeline/ingest-wordpress.js worm --limit 5  # cap pages (for testing)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchJSON } from './fetch.js';
import { cleanContent, decodeEntities } from './clean.js';

const PER_PAGE = 100;
const FIELDS = 'id,date,slug,link,title,content,categories,tags';
const CORPUS_DIR = 'data/corpus';

function apiUrl(work, page) {
  const q = `per_page=${PER_PAGE}&page=${page}&order=asc&orderby=date&_fields=${FIELDS}`;
  if (work.api === 'wpcom')
    return `https://public-api.wordpress.com/wp/v2/sites/${work.site}/posts?${q}`;
  if (work.api === 'wpjson')
    return `https://${work.site}/wp-json/wp/v2/posts?${q}`;
  throw new Error(`Unknown api type "${work.api}" for ${work.slug}`);
}

async function ingestWork(work, limitPages) {
  const records = [];
  for (let page = 1; ; page++) {
    if (limitPages && page > limitPages) break;
    let data;
    try {
      ({ data } = await fetchJSON(apiUrl(work, page)));
    } catch (err) {
      // The API returns a 400 (rest_post_invalid_page_number) once you page past
      // the end — that's the normal stop condition, not a real error.
      if (String(err.message).includes('HTTP 400')) break;
      throw err;
    }
    if (!Array.isArray(data) || data.length === 0) break;

    for (const post of data) {
      const text = cleanContent(post.content?.rendered ?? '');
      records.push({
        id: `${work.slug}:${post.slug}`,
        work: work.title,
        workSlug: work.slug,
        title: decodeEntities(post.title?.rendered ?? '').trim(),
        url: post.link,
        date: (post.date ?? '').slice(0, 10),
        order: records.length,
        wordCount: text ? text.split(/\s+/).length : 0,
        categories: post.categories ?? [],
        text,
      });
    }
    if (data.length < PER_PAGE) break;
  }

  await mkdir(CORPUS_DIR, { recursive: true });
  await writeFile(join(CORPUS_DIR, `${work.slug}.json`), JSON.stringify(records, null, 2));
  return records;
}

async function main() {
  const argv = process.argv.slice(2);
  const limitIdx = argv.indexOf('--limit');
  const limitPages = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 0;
  const limitValIdx = limitIdx >= 0 ? limitIdx + 1 : -1;
  const named = argv.filter((a, i) => !a.startsWith('--') && i !== limitValIdx);

  const { works } = JSON.parse(await readFile('config/works.json', 'utf8'));
  const targets = works.filter(
    (w) => (w.api === 'wpcom' || w.api === 'wpjson') && (named.length === 0 || named.includes(w.slug)),
  );

  for (const work of targets) {
    process.stdout.write(`Ingesting ${work.title}… `);
    const recs = await ingestWork(work, limitPages);
    const words = recs.reduce((n, r) => n + r.wordCount, 0);
    console.log(`${recs.length} posts, ${words.toLocaleString()} words`);
    const sample = recs.find((r) => r.wordCount > 200) ?? recs[0];
    if (sample)
      console.log(`   e.g. "${sample.title}" (${sample.date}) — ${sample.wordCount} words\n        ${sample.url}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
