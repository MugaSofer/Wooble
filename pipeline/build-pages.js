// Turn the cleaned corpus into per-chapter HTML that Pagefind can index.
//
// These pages are an *index input only* — they live in build/ (git-ignored) and
// are never deployed. Pagefind reads them, and the deployed site ships only the
// resulting search bundle + our UI. Each page carries Pagefind metadata so the
// search results can link out to the canonical chapter on Wildbow's own site.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CORPUS_DIR = 'data/corpus';
const BUILD_DIR = 'build';
const MIN_WORDS = 50; // skip announcement/nav-only posts

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pageHtml(rec) {
  const type = rec.type || 'Fiction';
  const year = rec.date ? rec.date.slice(0, 4) : '';

  // WoG indexes the question (context) and Wildbow's answer together; fiction
  // indexes the chapter prose. Extra meta lets the UI render WoG distinctly.
  let body, extraMeta = '';
  if (type === 'WoG') {
    // Body (searchable): de-weighted question + Wildbow's answer, so a topic
    // raised only in the question still surfaces his reply without outranking
    // real answers. The question and answer are ALSO emitted as meta in the
    // hidden block below; the UI renders them from those separate fields (never
    // the merged excerpt), so question text is never misattributed to Wildbow.
    const q = rec.question ? `    <p data-pagefind-weight="0.1">${esc(rec.question)}</p>\n` : '';
    body = `${q}    <p>${esc(rec.text)}</p>`;
    extraMeta =
      `    <span data-pagefind-meta="source">${esc(rec.source ?? 'Comment')}</span>\n` +
      `    <span data-pagefind-meta="chapter">${esc(rec.chapterTitle ?? '')}</span>\n` +
      `    <span data-pagefind-meta="asked_by">${esc(rec.parentAuthor ?? '')}</span>\n` +
      (rec.question ? `    <span data-pagefind-meta="question">${esc(rec.question)}</span>\n` : '') +
      `    <span data-pagefind-meta="answer">${esc(rec.text)}</span>\n`;
  } else {
    body = rec.text.split('\n\n').filter(Boolean).map((p) => `    <p>${esc(p)}</p>`).join('\n');
  }

  // Metadata/filters live in a hidden block *outside* the indexed body, so their
  // labels never leak into search snippets. Pagefind still captures them.
  // One metadata source per element (an element gets at most one
  // data-pagefind-meta); `url[href]` pulls the canonical link from the attribute.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex">
  <title>${esc(rec.work)} — ${esc(rec.title)}</title>
</head>
<body>
  <div hidden>
    <span data-pagefind-filter="work" data-pagefind-meta="work">${esc(rec.work)}</span>
    <span data-pagefind-filter="type" data-pagefind-meta="type">${esc(type)}</span>
    ${year ? `<span data-pagefind-filter="year">${esc(year)}</span>` : ''}
    <time data-pagefind-meta="date" data-pagefind-sort="date">${esc(rec.date)}</time>
    <a data-pagefind-meta="url[href]" href="${esc(rec.url)}">source</a>
${extraMeta}  </div>
  <main data-pagefind-body>
    <h1 data-pagefind-meta="title">${esc(rec.title)}</h1>
${body}
  </main>
</body>
</html>`;
}

async function main() {
  await rm(BUILD_DIR, { recursive: true, force: true });
  // Clear the previous index bundle too: Pagefind hashes fragment filenames by
  // content and doesn't purge old ones, so without this they accumulate across
  // rebuilds and bloat the deploy.
  await rm('site/pagefind', { recursive: true, force: true });

  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json'));
  let total = 0,
    skipped = 0;
  const years = new Set();
  const workCounts = new Map();
  const typeCounts = new Map();

  for (const file of files) {
    const recs = JSON.parse(await readFile(join(CORPUS_DIR, file), 'utf8'));
    for (const rec of recs) {
      // Skip empty/announcement fiction posts, but keep all non-empty WoG —
      // Wildbow's replies are often a valuable single sentence.
      const isWoG = (rec.type || 'Fiction') === 'WoG';
      if (isWoG ? rec.wordCount === 0 : rec.wordCount < MIN_WORDS) {
        skipped++;
        continue;
      }
      const dir = join(BUILD_DIR, rec.workSlug);
      await mkdir(dir, { recursive: true });
      // Derive a filesystem-safe slug from the chapter id.
      const slug = rec.id.split(':').slice(1).join(':').replace(/[^a-z0-9-]+/gi, '-');
      await writeFile(join(dir, `${slug}.html`), pageHtml(rec));
      total++;
      workCounts.set(rec.work, (workCounts.get(rec.work) ?? 0) + 1);
      typeCounts.set(rec.type || 'Fiction', (typeCounts.get(rec.type || 'Fiction') ?? 0) + 1);
      if (rec.date) years.add(rec.date.slice(0, 4));
    }
  }

  // Build-time metadata so the UI can populate its filter dropdowns instantly,
  // without waiting on the Pagefind index to load. Derived from the actual
  // corpus, so the year range tracks whatever sources are present.
  const meta = {
    works: [...workCounts].sort((a, b) => a[0].localeCompare(b[0])),
    types: [...typeCounts].sort((a, b) => a[0].localeCompare(b[0])),
    years: [...years].sort(),
    chapters: total,
  };
  await mkdir('site', { recursive: true });
  await writeFile(join('site', 'meta.json'), JSON.stringify(meta));

  console.log(`Wrote ${total} chapter pages to ${BUILD_DIR}/ (skipped ${skipped} short posts).`);
  console.log(`Wrote site/meta.json: ${meta.works.length} works, years ${meta.years[0]}–${meta.years.at(-1)}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
