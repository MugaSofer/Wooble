// Ingest Wildbow's "Snippets & Samples" — short-fiction drafts/samples posted on
// his blog (wildbow.wordpress.com): Boil (proto-Twig), Face, Peer, Before Worm.
// The WordPress REST API host is unreachable from here, so scrape the blog HTML
// (the .entry content) like the Ward pipeline does. Records land in the "Short
// Fiction" collection, tier "draft" (non-canon side material).
import { parse } from 'node-html-parser';
import { mkdir, writeFile } from 'node:fs/promises';
import { cleanContent } from './clean.js';

const UA = 'wooble-fan-archive/0.1 (personal WoG search project)';
const CAT = 'https://wildbow.wordpress.com/category/posts/snippets-samples/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.text();
}

// Every dated permalink in the category listing (paginated, though there's one page).
async function postList() {
  const out = new Map();
  for (let pg = 1; pg <= 4; pg++) {
    let html; try { html = await get(CAT + (pg > 1 ? `page/${pg}/` : '')); } catch { break; }
    let found = 0;
    for (const a of parse(html).querySelectorAll('a')) {
      const m = (a.getAttribute('href') || '').match(/^https:\/\/wildbow\.wordpress\.com\/(\d{4})\/(\d{2})\/(\d{2})\/([a-z0-9-]+)\/?$/i);
      if (m && !out.has(m[0])) { out.set(m[0], `${m[1]}-${m[2]}-${m[3]}`); found++; }
    }
    if (!found) break;
    await sleep(500);
  }
  return out;
}

const records = [];
const posts = await postList();
for (const [url, date] of posts) {
  const root = parse(await get(url));
  const title = (root.querySelector('title')?.text || '').replace(/\s*\|\s*Pig'?s Pen\s*$/i, '').trim();
  const entry = root.querySelector('.entry') || root.querySelector('.entrytext') || root.querySelector('.post');
  const text = entry ? cleanContent(entry.innerHTML) : '';
  const slug = url.match(/\/([a-z0-9-]+)\/?$/i)[1];
  // "Sample(s): Boil/Face/Peer" are writing samples; "Snippets: Before Worm" is a draft.
  const tier = /^\s*samples?\b/i.test(title) ? 'sample' : 'draft';
  records.push({
    id: `sf:${slug}`, work: 'Short Fiction', workSlug: 'short-fiction', type: 'Reference',
    tier, docTitle: title, title, text, url, date, wordCount: words(text),
  });
  process.stderr.write(`  ${date}  ${title.slice(0, 34).padEnd(34)} ${words(text)}w\n`);
  await sleep(600);
}

await mkdir('data/corpus', { recursive: true });
await writeFile('data/corpus/short-fiction.json', JSON.stringify(records, null, 2));
console.log(`\n${records.length} snippet posts, ${records.reduce((s, r) => s + r.wordCount, 0).toLocaleString()} words.`);
