// Ingest Wildbow's "Word of God" from the comment sections of his WordPress
// serials. The public API won't filter comments by author, so we page through
// every comment on a site (cached, rate-limited) and keep the ones authored by
// Wildbow (matched by his numeric user id, taken from the post author). For each
// of his comments we attach the parent comment — the question he's replying to —
// as context, and use the comment's own permalink as the deep-link.
//
// Usage: node pipeline/ingest-comments.js [worm pact ...]
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchJSON } from './fetch.js';
import { htmlToText } from './clean.js';

const CORPUS_DIR = 'data/corpus';
const PER_PAGE = 100;

// Drop quoted text (blockquotes) so a comment keeps only the commenter's own
// words — the parent comment is captured separately as context. Strip innermost
// quotes first and repeat until stable: a single lazy /<blockquote[\s\S]*?<\/blockquote>/
// pass stops at the FIRST close tag, so a nested quote leaks the outer quote's
// tail as if it were the commenter's own words.
const cleanComment = (html) => {
  let s = String(html ?? '');
  for (let prev; prev !== s; ) {
    prev = s;
    s = s.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote\s*>/gi, '');
  }
  return htmlToText(s);
};

const SITES = [
  { slug: 'worm', site: 'parahumans.wordpress.com', work: 'Worm' },
  { slug: 'pact', site: 'pactwebserial.wordpress.com', work: 'Pact' },
  { slug: 'twig', site: 'twigserial.wordpress.com', work: 'Twig' },
  { slug: 'pale', site: 'palewebserial.wordpress.com', work: 'Pale' },
  { slug: 'claw', site: 'clawwebserial.blog', work: 'Claw' },
  { slug: 'seek', site: 'seekwebserial.wordpress.com', work: 'Seek' },
];

// Map each chapter's canonical URL to its work/title, from the fiction corpus,
// so a WoG comment can be labelled with the chapter it sits under.
async function loadChapterMap() {
  const map = new Map();
  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('wog'));
  for (const f of files) {
    const recs = JSON.parse(await readFile(join(CORPUS_DIR, f), 'utf8'));
    for (const r of recs) map.set(r.url.replace(/\/$/, ''), r);
  }
  return map;
}

async function wildbowId(site) {
  const { data } = await fetchJSON(
    `https://public-api.wordpress.com/wp/v2/sites/${site}/posts?per_page=1&_fields=author`);
  return data[0]?.author;
}

async function ingestSite(s, chapterMap) {
  const base = `https://public-api.wordpress.com/wp/v2/sites/${s.site}`;
  const wbId = await wildbowId(s.site);

  const byId = new Map(); // id -> { author_name, content } for parent lookups
  const mine = []; // Wildbow's own comments (full)
  let scanned = 0;

  for (let page = 1; ; page++) {
    let data;
    try {
      ({ data } = await fetchJSON(
        `${base}/comments?per_page=${PER_PAGE}&order=asc&page=${page}` +
        `&_fields=id,parent,author,author_name,date,link,content`));
    } catch (err) {
      if (String(err.message).includes('HTTP 400')) break; // past the last page
      throw err;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const c of data) {
      byId.set(c.id, { author_name: c.author_name, content: c.content?.rendered ?? '' });
      if (c.author === wbId) mine.push(c);
      scanned++;
    }
    // NB: don't stop on a short page — the comments API returns occasional
    // sub-100 pages mid-stream. Only an empty page or the past-the-end 400
    // (caught above) marks the real end.
  }

  const records = mine.map((c) => {
    // The comment permalink can carry a /comment-page-N/ segment; strip it (and
    // the anchor) to recover the canonical chapter URL for the corpus lookup.
    const chapterUrl = (c.link ?? '')
      .split('#')[0]
      .replace(/\/comment-page-\d+\/?$/, '')
      .replace(/\/$/, '');
    const chapter = chapterMap.get(chapterUrl);
    const parent = c.parent ? byId.get(c.parent) : null;
    const answer = cleanComment(c.content?.rendered);
    const question = parent ? cleanComment(parent.content) : '';
    return {
      id: `wog:${s.slug}:${c.id}`,
      type: 'WoG',
      source: 'Comment', // blog comment; future WoG sources set their own label
      work: chapter?.work ?? s.work,
      workSlug: chapter?.workSlug ?? s.slug,
      title: chapter ? `WoG · ${chapter.title}` : `WoG · ${s.work}`,
      chapterTitle: chapter?.title ?? '',
      url: c.link,
      date: (c.date ?? '').slice(0, 10),
      parentAuthor: parent?.author_name ?? '',
      question,
      text: answer,
      wordCount: answer ? answer.split(/\s+/).length : 0,
    };
  });

  records.sort((a, b) => a.date.localeCompare(b.date));
  records.forEach((r, i) => (r.order = i));
  await mkdir(CORPUS_DIR, { recursive: true });
  await writeFile(join(CORPUS_DIR, `wog-${s.slug}.json`), JSON.stringify(records, null, 2));
  return { scanned, wog: records.length };
}

async function main() {
  const named = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const targets = SITES.filter((s) => named.length === 0 || named.includes(s.slug));
  const chapterMap = await loadChapterMap();

  for (const s of targets) {
    process.stdout.write(`WoG from ${s.work}… `);
    const { scanned, wog } = await ingestSite(s, chapterMap);
    console.log(`scanned ${scanned.toLocaleString()} comments → ${wog.toLocaleString()} from Wildbow`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
