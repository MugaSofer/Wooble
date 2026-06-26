// Ingest Wildbow WoG from saved pages of the SpaceBattles "Worm Quotes and WoG
// Repository" thread. SpaceBattles is behind Cloudflare and disallows scraping,
// so we don't fetch it — instead we parse HTML pages saved from a browser into
// the SRC_DIR folder. Each repository entry is a contributor's topic line
// followed by a blockquote of Wildbow's words with a link to the original source.
//
// Save pages via the browser (File > Save Page As > "Webpage, HTML Only") into
// the folder below, then run: node pipeline/ingest-spacebattles.js
import { parse } from 'node-html-parser';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { htmlToText } from './clean.js';

const SRC_DIR = 'Spacebattles WoG Repository';
const CORPUS_DIR = 'data/corpus';
const THREAD = 'https://forums.spacebattles.com/threads/worm-quotes-and-wog-repository.294448';

// Label for an *external origin* link (SpaceBattles attributions are handled
// separately, since the repository is itself hosted on SpaceBattles).
function sourceLabel(url) {
  if (/reddit\.com/i.test(url)) return 'Reddit';
  if (/sufficientvelocity\.com/i.test(url)) return 'SufficientVelocity';
  if (/parahumans\.(wordpress|net)/i.test(url)) return 'Blog';
  if (/formspring/i.test(url)) return 'Formspring';
  return 'Link';
}

// True if the node sits inside another quote block (a nested quote, not a
// top-level repository entry).
function insideQuote(node) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    const cls = p.getAttribute && p.getAttribute('class');
    if (cls && cls.includes('bbCodeBlock--quote')) return true;
  }
  return false;
}

// The XenForo post id of the post containing this node (for a source fallback).
function postId(node) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    const d = p.getAttribute && p.getAttribute('data-content');
    if (d && d.startsWith('post-')) return d.slice(5);
  }
  return null;
}

// The contributor's framing text immediately before a quote (e.g. "Wildbow, on
// Leet's power:"), stopping at any preceding quote.
function precedingText(bq) {
  const siblings = bq.parentNode.childNodes;
  const idx = siblings.indexOf(bq);
  const parts = [];
  for (let i = idx - 1; i >= 0; i--) {
    const n = siblings[i];
    if (n.tagName && n.tagName.toLowerCase() === 'blockquote') break;
    const t = (n.text || '').replace(/\s+/g, ' ').trim();
    if (t) parts.unshift(t);
  }
  return parts.join(' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/Click to (expand|shrink)\.\.\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The post body (bbWrapper) containing a node.
function bbWrapperOf(node) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    const cls = p.getAttribute && p.getAttribute('class');
    if (cls && cls.split(' ').includes('bbWrapper')) return p;
  }
  return null;
}

// Origin links the repository cites. SpaceBattles links are handled via the
// quote's own attribution, so they're excluded here.
const SOURCE_RE = /reddit\.com|sufficientvelocity\.com|parahumans\.(wordpress|net)|formspring|blogspot|pastebin/i;

// In-document-order markers within a post: each top-level quote and each source
// link. We don't descend into quotes, so a quote's own links aren't sources.
function markers(wrap) {
  const out = [];
  (function walk(node) {
    for (const c of node.childNodes) {
      if (!c.tagName) continue;
      const cls = c.getAttribute('class') || '';
      if (c.tagName.toLowerCase() === 'blockquote' && cls.includes('bbCodeBlock--quote')) {
        out.push({ kind: 'quote', node: c });
        continue; // a quote's contents are not source markers
      }
      if (c.tagName.toLowerCase() === 'a' && SOURCE_RE.test(c.getAttribute('href') || '')) {
        out.push({ kind: 'link', href: c.getAttribute('href') });
      }
      walk(c);
    }
  })(wrap);
  return out;
}

// The source link nearest a quote within its post, not separated from it by
// another quote — so each quote keeps its own source even in multi-quote posts.
function sourceLinkFor(bq) {
  const wrap = bbWrapperOf(bq);
  if (!wrap) return '';
  const ms = markers(wrap);
  const idx = ms.findIndex((m) => m.node === bq);
  if (idx < 0) return '';
  for (let i = idx - 1; i >= 0; i--) { if (ms[i].kind === 'quote') break; if (ms[i].kind === 'link') return ms[i].href; }
  for (let i = idx + 1; i < ms.length; i++) { if (ms[i].kind === 'quote') break; if (ms[i].kind === 'link') return ms[i].href; }
  return '';
}

const SB_ORIGIN = 'https://forums.spacebattles.com';
const absolute = (url) => (url && url.startsWith('/') ? SB_ORIGIN + url : url);

async function main() {
  let files;
  try {
    files = (await readdir(SRC_DIR)).filter((f) => f.endsWith('.html'));
  } catch {
    console.error(`Folder "${SRC_DIR}" not found. Save the thread pages there first.`);
    process.exit(1);
  }

  const seen = new Set();
  const records = [];

  for (const file of files) {
    const root = parse(await readFile(join(SRC_DIR, file), 'utf8'));
    // Collect top-level Wildbow quotes first (before mutating the tree).
    const quotes = root
      .querySelectorAll('blockquote.bbCodeBlock--quote')
      .filter((bq) => /wildbow/i.test(bq.getAttribute('data-quote') || '') && !insideQuote(bq));

    for (const bq of quotes) {
      const context = precedingText(bq);
      const content = bq.querySelector('.bbCodeBlock-content');
      if (!content) continue;
      // Drop nested quotes and the "Click to expand" UI before reading text.
      content.querySelectorAll('blockquote, .bbCodeBlock-expandLink, .js-expandLink').forEach((n) => n.remove());
      const text = htmlToText(content.innerHTML)
        .replace(/Click to (expand|shrink)\.\.\./g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length < 15) continue;

      const key = text.slice(0, 120);
      if (seen.has(key)) continue; // de-dupe across overlapping saved pages
      seen.add(key);

      const jump = bq.querySelector('.bbCodeBlock-sourceJump');
      const jumpHref = jump ? absolute(jump.getAttribute('href')) : '';
      const origin = sourceLinkFor(bq);
      const pid = postId(bq);
      const wogPost = pid ? `${THREAD}/post-${pid}` : THREAD; // where it's compiled

      // Primary origin: a cited external source; else Wildbow's own post in
      // *another* SB thread; else the WoG repository thread itself (a
      // compilation, not a Wildbow post — a distinct "WoG Thread" source).
      let url, source;
      if (jumpHref && !/294448/.test(jumpHref)) { url = jumpHref; source = 'SpaceBattles'; }
      else if (origin) { url = origin; source = sourceLabel(origin); }
      else { url = wogPost; source = 'WoG Thread'; }

      records.push({
        id: `wog:sb:${createHash('sha1').update(key).digest('hex').slice(0, 12)}`,
        type: 'WoG',
        source,
        work: 'Worm',
        workSlug: 'worm',
        title: context ? `WoG · ${context.slice(0, 70)}` : 'WoG · Worm',
        chapterTitle: '',
        url,
        wogUrl: url === wogPost ? '' : wogPost, // secondary "compiled in" link
        date: '', // SpaceBattles doesn't expose the original quote's date
        parentAuthor: '', // a topic line, not a question from a person
        question: context,
        text,
        wordCount: text.split(/\s+/).length,
      });
    }
  }

  records.forEach((r, i) => (r.order = i));
  await mkdir(CORPUS_DIR, { recursive: true });
  await writeFile(join(CORPUS_DIR, 'wog-spacebattles.json'), JSON.stringify(records, null, 2));

  const bySource = {};
  records.forEach((r) => (bySource[r.source] = (bySource[r.source] || 0) + 1));
  console.log(`SpaceBattles WoG: ${records.length} Wildbow quotes from ${files.length} saved file(s).`);
  console.log('by source link:', JSON.stringify(bySource));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
