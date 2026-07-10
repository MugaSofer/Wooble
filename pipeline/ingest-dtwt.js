// Ingest Wildbow's "Do The Write Thing" stories — original short fiction he wrote
// to the podcast's per-episode writing prompts, posted as Reddit comments in
// r/DoTheWriteThing. Pulled via PullPush (Reddit blocks direct scraping). A story
// may be split across several comments (Reddit's length limit), so merge the
// long comments per episode; short comments are feedback/chatter and dropped.
// Records land in the "Short Fiction" collection, tier "draft".
import { mkdir, writeFile } from 'node:fs/promises';

const AUTHOR = 'Wildbow';
const SUB = 'DoTheWriteThing';
const API = 'https://api.pullpush.io/reddit/search/comment/';
const STORY_MIN = 1500; // chars: a story part vs a feedback reply
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

async function allComments() {
  const out = [];
  let before = '';
  const MAX_PAGES = 10;
  let page = 0;
  for (; page < MAX_PAGES; page++) {
    const url = `${API}?author=${AUTHOR}&subreddit=${SUB}&size=100&sort=desc${before ? `&before=${before}` : ''}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'wooble-fan-archive/0.1' } });
    if (!r.ok) throw new Error('PullPush HTTP ' + r.status);
    const items = (await r.json()).data || [];
    out.push(...items);
    if (items.length < 100) break;
    before = items[items.length - 1].created_utc;
    await sleep(700);
  }
  if (page === MAX_PAGES) console.warn(`ingest-dtwt: hit the ${MAX_PAGES}-page cap — older comments may be missing; raise MAX_PAGES.`);
  return out;
}

// Reddit markdown → plain text (light): unescape, drop link URLs, heading/bold/
// italic/quote markers and "[Continued…]" seams; keep paragraph breaks.
function mdText(s) {
  return String(s || '')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[Continued[^\]]*\]/gi, '')
    .replace(/^#{1,6}\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
    .replace(/^>\s?/gm, '').replace(/\r/g, '')
    .split(/\n{2,}/).map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter((p) => p && !/^[*\-_⧫⬥•·—–~=\s]+$/.test(p)) // drop separator-only lines (***, ⬥, ---)
    .join('\n\n').trim();
}

function titleOf(raw) {
  for (const line of String(raw).split('\n')) {
    const t = line.trim();
    const m = t.match(/^#{1,6}\s*(.{2,55}?)\s*$/) || t.match(/^\*\*\s*(.{2,55}?)\s*\*\*$/);
    if (m) { const c = m[1].replace(/[*#⧫⬥\s]+$/g, '').replace(/^[⧫⬥\s]+/, '').trim(); if (c.length >= 2) return c; }
  }
  return null;
}

const comments = await allComments();
const byEp = new Map();
for (const c of comments) { if (!byEp.has(c.link_id)) byEp.set(c.link_id, []); byEp.get(c.link_id).push(c); }

const records = [];
for (const [linkId, cs] of byEp) {
  const parts = cs.filter((c) => (c.body || '').length >= STORY_MIN).sort((a, b) => a.created_utc - b.created_utc);
  if (!parts.length) continue; // an episode of only chatter
  const ep = linkId.replace(/^t3_/, '');
  const raw = parts.map((p) => p.body).join('\n\n');
  const title = titleOf(raw) || `Do The Write Thing (${new Date(parts[0].created_utc * 1000).toISOString().slice(0, 10)})`;
  const text = mdText(raw);
  records.push({
    id: `sf:dtwt:${ep}`, work: 'Short Fiction', workSlug: 'short-fiction', type: 'Reference',
    tier: 'story', docTitle: title, title, // finished prompt-stories, not drafts
    text, url: `https://www.reddit.com/r/${SUB}/comments/${ep}/comment/${parts[0].id}/`,
    date: new Date(parts[0].created_utc * 1000).toISOString().slice(0, 10), wordCount: words(text),
  });
  process.stderr.write(`  ${records[records.length - 1].date}  ${title.slice(0, 34).padEnd(34)} ${words(text)}w (${parts.length} part${parts.length > 1 ? 's' : ''})\n`);
}

await mkdir('data/corpus', { recursive: true });
await writeFile('data/corpus/dtwt.json', JSON.stringify(records, null, 2));
console.log(`\n${records.length} DTWT stories, ${records.reduce((s, r) => s + r.wordCount, 0).toLocaleString()} words.`);
