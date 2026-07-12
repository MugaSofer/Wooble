// Ingest Wildbow's "Word of God" from Ward's comment sections. Ward is
// self-hosted (parahumans.net) and blocks its WordPress REST API (403), so the
// API-based comment scan in ingest-comments.js can't reach it. But the theme
// renders every comment server-side, inline in the chapter HTML (no wpDiscuz /
// Disqus / AJAX and — checked across the run — no comment pagination), and marks
// the site author's own comments with `comment-author-wildbow bypostauthor`. So
// we fetch each chapter page (like the Ward chapter scraper does), pull his
// comments straight out of the markup, and attach the parent comment as context.
//
// Output matches ingest-comments.js exactly (wog-ward.json), so classification
// and the build treat Ward WoG comments like every other serial's.
//
// Usage: node pipeline/ingest-ward-comments.js
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'node-html-parser';
import { htmlToText } from './clean.js';

const CORPUS_DIR = 'data/corpus';
const CACHE_DIR = 'data/raw/ward-comments';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'; // parahumans.net 403s non-browser agents
const SB_ORIGIN = 'https://www.parahumans.net';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drop quoted text (blockquotes) so a comment keeps only the commenter's own
// words — the parent comment is captured separately as context. Innermost-first,
// repeat until stable (same reasoning as ingest-comments.js's cleanComment).
const cleanComment = (html) => {
  let s = String(html ?? '');
  for (let prev; prev !== s; ) {
    prev = s;
    s = s.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote\s*>/gi, '');
  }
  return htmlToText(s);
};

const absolute = (url) => (url && url.startsWith('/') ? SB_ORIGIN + url : url);
const cacheName = (url) => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_') + '.html';

async function fetchChapter(url) {
  const cache = join(CACHE_DIR, cacheName(url));
  if (existsSync(cache)) return readFile(cache, 'utf8');
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const html = await res.text();
  await writeFile(cache, html);
  await sleep(400); // be polite to the self-hosted box
  return html;
}

// The nearest enclosing comment <li> above this node (a reply's parent = the
// comment it answers). Null for a top-level comment.
function parentComment(li) {
  for (let p = li.parentNode; p; p = p.parentNode) {
    if (p === li) continue;
    const tag = p.tagName && p.tagName.toLowerCase();
    const cls = (p.getAttribute && p.getAttribute('class')) || '';
    if (tag === 'li' && /\bcomment\b/.test(cls)) return p;
  }
  return null;
}

// A comment's own fields, reading only its own header/body — NOT its nested
// replies. querySelector returns the first match in document order, and a
// comment's own author/time/content precede its children <ul>, so the first hit
// is always the comment's own (never a reply's).
const authorOf = (li) => {
  const fn = li.querySelector('.comment-author .fn, cite.fn, .fn');
  return fn ? fn.text.replace(/\s+/g, ' ').trim() : '';
};
const contentOf = (li) => {
  const c = li.querySelector('.comment-content');
  return c ? cleanComment(c.innerHTML) : '';
};

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  const ward = JSON.parse(await readFile(join(CORPUS_DIR, 'ward.json'), 'utf8'));
  const chapters = ward.filter((r) => /parahumans\.net\/\d{4}\//.test(r.url));

  const records = [];
  let scanned = 0, fetched = 0, chaptersWithWoG = 0;

  for (const chap of chapters) {
    const cache = join(CACHE_DIR, cacheName(chap.url));
    if (!existsSync(cache)) fetched++;
    let html;
    try { html = await fetchChapter(chap.url); }
    catch (e) { process.stderr.write(`  MISS ${chap.title}: ${e.message}\n`); continue; }

    const root = parse(html);
    const mine = root
      .querySelectorAll('li.comment')
      .filter((li) => /comment-author-wildbow|bypostauthor/.test(li.getAttribute('class') || ''));
    scanned += root.querySelectorAll('li.comment').length;
    if (mine.length) chaptersWithWoG++;

    for (const li of mine) {
      const id = (li.getAttribute('id') || '').replace(/^comment-/, ''); // "comment-2950" -> "2950"
      if (!id) continue;
      const text = contentOf(li);
      if (!text || text.length < 15) continue; // skip empty / one-word acknowledgements
      const time = li.querySelector('.comment-metadata time, time');
      const date = (time && time.getAttribute('datetime') ? time.getAttribute('datetime') : '').slice(0, 10);
      const permaEl = li.querySelector('.comment-metadata a[href*="#comment-"], a[href*="#comment-"]');
      const url = permaEl ? absolute(permaEl.getAttribute('href')) : `${chap.url}#comment-${id}`;
      const parent = parentComment(li);
      const question = parent ? contentOf(parent) : '';
      const parentAuthor = parent ? authorOf(parent) : '';

      records.push({
        id: `wog:ward:${id}`,
        type: 'WoG',
        source: 'Comment',
        work: 'Ward',
        workSlug: 'ward',
        title: `WoG · ${chap.title}`,
        chapterTitle: chap.title,
        url,
        date,
        parentAuthor,
        question,
        text,
        wordCount: text.split(/\s+/).length,
      });
    }
  }

  records.sort((a, b) => a.date.localeCompare(b.date));
  records.forEach((r, i) => (r.order = i));
  await writeFile(join(CORPUS_DIR, 'wog-ward.json'), JSON.stringify(records, null, 2));

  console.log(
    `Ward WoG: scanned ${scanned.toLocaleString()} comments across ${chapters.length} chapters ` +
    `(${fetched} newly fetched) → ${records.length} from Wildbow, on ${chaptersWithWoG} chapters.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
