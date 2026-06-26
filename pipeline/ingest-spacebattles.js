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
  if (/docs\.google|drive\.google/i.test(url)) return 'Google Docs';
  if (/myth-weavers/i.test(url)) return 'Myth-Weavers';
  return 'Other'; // some other site Wildbow posted on (pastebin, blogspot, etc.)
}

// Hand corrections: a few repository entries link to the wrong place (a
// fat-fingered href with label text or a whole quote pasted into the link).
// Keyed by record id (a stable hash of the quote) → the correct origin URL.
const URL_FIXES = {
  // "GG's Aura a non-factor in Amy's issues" — label text pasted as the link
  'wog:sb:ae2f94555bd5': 'https://www.reddit.com/r/Parahumans/comments/185657e/comment/kb1od7b/',
  // "I'm leaning toward shaker or breaker for the kid" — whole quote pasted as the link
  'wog:sb:e336d8c3ae69': 'https://www.reddit.com/r/Parahumans/comments/5ic73i/power_this_trigger/db7crl5/?utm_source=share&utm_medium=ios_app&utm_name=iossmf&context=3',
  // "Nine hours fresh, from Reddit: What would have happened to Taylor…" — the
  // repository pasted the thread title but no link; source found by hand.
  'wog:sb:eff8404fef66': 'https://www.reddit.com/r/Parahumans/comments/2szsy2/comment/cnuqjfd/',
};

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

// The author of the post containing this node (XenForo puts it on the message
// article as data-author). When it's Wildbow, the quote is his own WoG post in
// the thread — a primary SpaceBattles source, not a fan's compilation of one.
function postAuthor(node) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    const a = p.getAttribute && p.getAttribute('data-author');
    if (a) return a;
  }
  return '';
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

// Classify a link in the contributor's text:
//   'link'     — a usable external source (reddit, SV, gdocs, myth-weavers, …).
//                Deliberately broad so a quote beside an unusual-site link is
//                attributed to it rather than dumped as thread-only.
//   'deadlink' — an intended source we can't use: a dead/expiring Discord CDN
//                attachment, or a fat-fingered href (label text or a whole quote
//                pasted in, so the "host" has a space or no dot). It still
//                *claims* its quote — the scan stops here rather than scavenge a
//                neighbour's link — so the entry falls back to a repository link.
//   null       — not a source: a non-http or SpaceBattles link (SB attribution
//                is handled via the quote's own sourceJump).
function linkKind(href) {
  const m = /^https?:\/\/([^/?#]*)/i.exec(href);
  if (!m) return null;
  const host = m[1];
  if (/spacebattles\.com$/i.test(host)) return null;
  if (/\s/.test(host) || !host.includes('.')) return 'deadlink';   // malformed href
  if (/(^|\.)cdn\.discordapp\.com$/i.test(host)) return 'deadlink'; // dead attachment
  return 'link';
}

// In-document-order markers within a post: each top-level quote, each source
// link, and each run of contributor text. We don't descend into quotes (their
// own links aren't sources) or into links (their anchor text isn't a label).
// Text markers matter for attribution: a label between quotes starts a new entry.
function markers(wrap) {
  const out = [];
  (function walk(node) {
    for (const c of node.childNodes) {
      if (!c.tagName) {
        const t = (c.text || '').replace(/Click to (expand|shrink)\.\.\./g, '').trim();
        if (/[A-Za-z0-9]/.test(t)) out.push({ kind: 'text' });
        continue;
      }
      const tag = c.tagName.toLowerCase();
      const cls = c.getAttribute('class') || '';
      if (tag === 'blockquote' && cls.includes('bbCodeBlock--quote')) {
        out.push({ kind: 'quote', node: c });
        continue;
      }
      if (tag === 'a') {
        const href = c.getAttribute('href') || '';
        const kind = linkKind(href);
        if (kind) out.push({ kind, href });
        continue;
      }
      walk(c);
    }
  })(wrap);
  return out;
}

// The source link for a quote within its post. A link before the quote
// attributes it; the backward scan crosses consecutive quotes (a link followed
// by several quotes with nothing between them are all from that link). It stops
// only when contributor text sits *between two quotes* — that's a label starting
// a new entry. Text between the link and the first quote is that entry's own
// framing ("Wildbow on Reddit:") and is fine. The forward scan (a link right
// after the quote) never crosses another quote.
function sourceLinkFor(bq) {
  const wrap = bbWrapperOf(bq);
  if (!wrap) return '';
  const ms = markers(wrap);
  const idx = ms.findIndex((m) => m.node === bq);
  if (idx < 0) return '';
  let pendingText = false; // text seen in the current gap (resets at each quote)
  for (let i = idx - 1; i >= 0; i--) {
    const m = ms[i];
    if (m.kind === 'link') return m.href;
    if (m.kind === 'deadlink') return '';   // source claimed but unusable → repository link
    if (m.kind === 'text') { pendingText = true; continue; }
    if (m.kind === 'quote') { if (pendingText) break; pendingText = false; }
  }
  for (let i = idx + 1; i < ms.length; i++) {
    if (ms[i].kind === 'quote') break;
    if (ms[i].kind === 'deadlink') return '';
    if (ms[i].kind === 'link') return ms[i].href;
  }
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

  // Sonnet-derived source attributions for entries the deterministic scan left
  // as thread-only (id -> {source, url}), verified before being written here:
  // Blog links checked against our scraped comments, URLs confirmed present in
  // the source transcript, dead/Discord links rejected.
  let threadFixes = {};
  try { threadFixes = JSON.parse(await readFile('data/wog-thread-fixes.json', 'utf8')); } catch { /* none yet */ }

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
      const id = `wog:sb:${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;

      // Primary origin: a hand-corrected link (the repository got a few wrong);
      // else a cited external source; else — if Wildbow authored the post — his
      // own WoG post in this thread (a SpaceBattles primary source); else
      // Wildbow's post in *another* SB thread (via sourceJump); else the WoG
      // repository thread itself (a fan compilation — a distinct "WoG Thread").
      let url, source;
      if (URL_FIXES[id]) { url = URL_FIXES[id]; source = sourceLabel(url); }
      else if (threadFixes[id]) { url = threadFixes[id].url; source = threadFixes[id].source; }
      else if (jumpHref && !/294448/.test(jumpHref)) { url = jumpHref; source = 'SpaceBattles'; }
      else if (origin) { url = origin; source = sourceLabel(origin); }
      else if (/wildbow/i.test(postAuthor(bq))) { url = wogPost; source = 'SpaceBattles'; }
      else { url = wogPost; source = 'WoG Thread'; }

      records.push({
        id,
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
