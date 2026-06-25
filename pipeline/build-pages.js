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
  const paragraphs = rec.text
    .split('\n\n')
    .filter(Boolean)
    .map((p) => `    <p>${esc(p)}</p>`)
    .join('\n');

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
    <span data-pagefind-filter="type" data-pagefind-meta="type">Fiction</span>
    <time data-pagefind-meta="date">${esc(rec.date)}</time>
    <a data-pagefind-meta="url[href]" href="${esc(rec.url)}">source</a>
  </div>
  <main data-pagefind-body>
    <h1 data-pagefind-meta="title">${esc(rec.title)}</h1>
${paragraphs}
  </main>
</body>
</html>`;
}

async function main() {
  await rm(BUILD_DIR, { recursive: true, force: true });

  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json'));
  let total = 0,
    skipped = 0;

  for (const file of files) {
    const recs = JSON.parse(await readFile(join(CORPUS_DIR, file), 'utf8'));
    for (const rec of recs) {
      if (rec.wordCount < MIN_WORDS) {
        skipped++;
        continue;
      }
      const dir = join(BUILD_DIR, rec.workSlug);
      await mkdir(dir, { recursive: true });
      // Derive a filesystem-safe slug from the chapter id.
      const slug = rec.id.split(':').slice(1).join(':').replace(/[^a-z0-9-]+/gi, '-');
      await writeFile(join(dir, `${slug}.html`), pageHtml(rec));
      total++;
    }
  }

  console.log(`Wrote ${total} chapter pages to ${BUILD_DIR}/ (skipped ${skipped} short posts).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
