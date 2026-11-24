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
const UNATTR_CANDIDATES = 'data/sb-unattr-candidates.json'; // full text, git-ignored
const UNATTR_VERDICTS = 'data/sb-unattr-verdicts.json';     // Haiku verdicts, id -> {wildbow, kind}

// Post HTML → text that keeps line breaks (chat logs are unreadable without them).
// XenForo writes one break as "<br />" plus a newline, which htmlToText would
// count twice, turning every line break into a paragraph break.
const postText = (html) => htmlToText(html.replace(/(<br\s*\/?>)[ \t]*\r?\n/gi, '$1'))
  .replace(/Click to (expand|shrink)\.\.\./g, '')
  .replace(/[ \t]+$/gm, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
// One-line form. Ids and de-duplication are keyed on (and the classifier sees)
// this, so it must not change: hand fixes and verdicts are stored by id.
const flat = (t) => t.replace(/\s+/g, ' ').trim();

const CHAT_ATTR = /\b(discord|irc)\b/i; // quote attributed to a chat channel, not a person
const MONTHS =['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// "March 3, 2013" → "2013-03-03" ('' if unparseable).
function isoDate(s) {
  const m = /^(\w+) (\d{1,2}), (\d{4})$/.exec(s.trim());
  const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return mi < 0 ? '' : `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// Label for an *external origin* link (SpaceBattles attributions are handled
// separately, since the repository is itself hosted on SpaceBattles).
function sourceLabel(url) {
  if (/reddit\.com/i.test(url)) return 'Reddit';
  if (/sufficientvelocity\.com/i.test(url)) return 'SufficientVelocity';
  if (/parahumans\.(wordpress|net)/i.test(url)) return 'Blog';
  if (/formspring/i.test(url)) return 'Formspring';
  if (/docs\.google|drive\.google/i.test(url)) return 'Google Docs';
  if (/myth-weavers/i.test(url)) return 'Myth-Weavers';
  if (/rpg\.net/i.test(url)) return 'RPG.net';
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

// The publish date (YYYY-MM-DD) of the forum post this node sits in — i.e. when
// the quote was posted to the repository thread. The repository doesn't record
// when Wildbow originally said each quote, so this is a last-resort date: for a
// quote Wildbow posted himself it's exact, and for a fan's compiled quote it's
// the compile date (the best we have). XenForo puts the post time in the header
// as <time itemprop="datePublished" datetime="…">.
function postDate(node) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    const d = p.getAttribute && p.getAttribute('data-content');
    if (d && d.startsWith('post-')) {
      const t = p.querySelector('time[itemprop="datePublished"]') || p.querySelector('time[datetime]');
      const dt = t && t.getAttribute('datetime');
      return dt ? dt.slice(0, 10) : '';
    }
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
  // A forward link after contributor text that leads straight into another
  // quote is the *next* entry's label + link ("Yet more on X: <link> <quote>"),
  // not this one's ("<quote> Source: <link>").
  let sawText = false;
  for (let i = idx + 1; i < ms.length; i++) {
    if (ms[i].kind === 'quote') break;
    if (ms[i].kind === 'text') { sawText = true; continue; }
    if (sawText && ms[i + 1]?.kind === 'quote') break;
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

  // Haiku verdicts for blank-attribution quotes (id -> {wildbow, kind}); see
  // pipeline/sb-unattr-batch.js. Only verdict-approved ones are admitted.
  let unattrVerdicts = {};
  try { unattrVerdicts = JSON.parse(await readFile(UNATTR_VERDICTS, 'utf8')); } catch { /* none yet */ }

  const seen = new Set();
  const records = [];
  const candidates = []; // blank-attribution quotes, for classification

  // Two passes: Wildbow-attributed quotes, then blank-attribution ones — quotes
  // pasted from another site (RPG.net, blog comments, chat logs) lose XenForo's
  // "X said:" tag, so a whole post of Wildbow quotes can carry data-quote="".
  // Those are only admitted once classified as Wildbow (UNATTR_VERDICTS). The
  // attributed pass runs first so a blank duplicate never displaces one.
  for (const blank of [false, true]) for (const file of files) {
    const root = parse(await readFile(join(SRC_DIR, file), 'utf8'));
    // Collect top-level quotes first (before mutating the tree).
    const quotes = root
      .querySelectorAll('blockquote.bbCodeBlock--quote')
      .filter((bq) => !insideQuote(bq))
      .filter((bq) => {
        const attr = bq.getAttribute('data-quote') || '';
        if (blank) return !attr;
        // Chat logs are attributed to the channel ("Discord", "Parahumans IRC"),
        // not a speaker; keep those where Wildbow takes part.
        // "Wildblow": a contributor's typo that otherwise drops the quote.
        return /wildb?l?ow/i.test(attr) || (CHAT_ATTR.test(attr) && /wildbow/i.test(bq.text));
      });

    for (const bq of quotes) {
      const context = precedingText(bq);
      const content = bq.querySelector('.bbCodeBlock-content');
      if (!content) continue;
      // The quoted question (a nested quote), kept as context for blank-
      // attribution entries, where the label alone often says little.
      const nested = content.querySelector('.bbCodeBlock-expandContent blockquote .bbCodeBlock-expandContent');
      const nestedText = nested ? postText(nested.innerHTML) : '';
      // Drop nested quotes and the "Click to expand" UI before reading text.
      content.querySelectorAll('blockquote, .bbCodeBlock-expandLink, .js-expandLink').forEach((n) => n.remove());
      let text = postText(content.innerHTML);
      if (flat(text).length < 15) continue;

      const key = flat(text).slice(0, 120);
      if (seen.has(key)) continue; // de-dupe across overlapping saved pages
      seen.add(key);
      const id = `wog:sb:${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;

      // Original-post date carried in the pasted text, when there is one: a
      // WordPress comment header ("wildbow on March 3, 2013 at 1:27 PM said:")
      // or an RPG.net edit stamp ("Last edited by Wildbow; 11-21-2013 at …").
      let origDate = '';
      let question = context;
      if (blank) {
        // The classifier sees the raw text — those headers are speaker evidence.
        candidates.push({
          id, poster: postAuthor(bq), label: context, question: flat(nestedText),
          source: sourceLinkFor(bq), text: flat(text),
        });
        const verdict = unattrVerdicts[id];
        if (!verdict?.wildbow) continue;
        const wp = /^wildbow on (\w+ \d{1,2}, \d{4}) at [\d:]+ [AP]M said:\s*/i.exec(text);
        if (wp) { origDate = isoDate(wp[1]); text = text.slice(wp[0].length); }
        const ed = /\s*Last edited by Wildbow; (\d{2})-(\d{2})-(\d{4}) at [\d:]+ [AP]M\.?\s*$/i.exec(text);
        if (ed) { origDate = `${ed[3]}-${ed[1]}-${ed[2]}`; text = text.slice(0, ed.index); }
        // Pasted with the question they answer as a nested quote: that's better
        // context than the contributor's label. A few are inverted (Wildbow's
        // reply nested inside the fan's post) — `swap` puts them right way up.
        if (verdict.swap) [text, question] = [nestedText, text];
        else if (nestedText) question = nestedText;
      }

      const jump = bq.querySelector('.bbCodeBlock-sourceJump');
      const jumpHref = jump ? absolute(jump.getAttribute('href')) : '';
      const origin = sourceLinkFor(bq);
      const pid = postId(bq);
      const wogPost = pid ? `${THREAD}/post-${pid}` : THREAD; // where it's compiled

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
        // Fallback date: when the quote was posted to the repository thread.
        // Entries that merge into a dated bulk reddit/blog record at build get
        // that record's authoritative date instead; this covers the rest, which
        // would otherwise sort to the end of a by-date search as undated. A date
        // carried in pasted text (blank-attribution entries) is the real one.
        date: origDate || postDate(bq),
        parentAuthor: '', // a topic line, not a question from a person
        question,
        text,
        wordCount: text.split(/\s+/).length,
      });
    }
  }

  // Wildbow's own posts in the thread: early on he answered questions there
  // directly, as plain post text rather than quotes, which the quote scan above
  // never sees. Take the post body minus any quotes (those were handled above).
  const seenPosts = new Set();
  for (const file of files) {
    const root = parse(await readFile(join(SRC_DIR, file), 'utf8'));
    for (const art of root.querySelectorAll('article[data-author]')) {
      if (!/^wildbow$/i.test(art.getAttribute('data-author') || '')) continue;
      const wrap = art.querySelector('.bbWrapper');
      if (!wrap) continue;
      const pid = (art.getAttribute('data-content') || '').replace(/^post-/, '');
      if (!pid || seenPosts.has(pid)) continue;
      seenPosts.add(pid);
      const body = parse(wrap.innerHTML);
      body.querySelectorAll('blockquote').forEach((n) => n.remove());
      const text = postText(body.innerHTML);
      if (flat(text).length < 40) continue;
      const key = flat(text).slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const t = art.querySelector('time[itemprop="datePublished"]') || art.querySelector('time[datetime]');
      records.push({
        id: `wog:sb:${createHash('sha1').update(key).digest('hex').slice(0, 12)}`,
        type: 'WoG',
        source: 'SpaceBattles',
        work: 'Worm',
        workSlug: 'worm',
        title: 'WoG · Wildbow in the repository thread',
        chapterTitle: '',
        url: `${THREAD}/post-${pid}`,
        wogUrl: '',
        date: t ? (t.getAttribute('datetime') || '').slice(0, 10) : '',
        parentAuthor: '',
        question: '',
        text,
        wordCount: text.split(/\s+/).length,
      });
    }
  }

  records.forEach((r, i) => (r.order = i));
  await mkdir(CORPUS_DIR, { recursive: true });
  await writeFile(join(CORPUS_DIR, 'wog-spacebattles.json'), JSON.stringify(records, null, 2));
  await writeFile(UNATTR_CANDIDATES, JSON.stringify(candidates, null, 2));
  const admitted = candidates.filter((c) => unattrVerdicts[c.id]?.wildbow).length;
  console.log(`Blank-attribution quotes: ${candidates.length} candidates, ${admitted} admitted as Wildbow.`);

  const bySource = {};
  records.forEach((r) => (bySource[r.source] = (bySource[r.source] || 0) + 1));
  console.log(`SpaceBattles WoG: ${records.length} Wildbow quotes from ${files.length} saved file(s).`);
  console.log('by source link:', JSON.stringify(bySource));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
