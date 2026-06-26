// Build per-target context windows for the WoG-repository entries the
// deterministic parser left as "thread-only" (source 'WoG Thread'). For each
// such entry we render a window of its post in document order — every label,
// EVERY link (including the ones below the quotes and the non-source ones the
// attribution scan ignores), and the surrounding quotes — so an LLM can read
// the whole layout and decide the entry's real source. Output is consumed by the
// Sonnet pass; nothing here mutates the corpus.
import { parse } from 'node-html-parser';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { htmlToText } from './clean.js';

const SRC_DIR = 'Spacebattles WoG Repository';
const CORPUS = 'data/corpus/wog-spacebattles.json';
const OUT = 'data/wog-thread-context.json';
const WINDOW = 12; // markers of context on each side of the target quote

const insideQuote = (node) => {
  for (let p = node.parentNode; p; p = p.parentNode) {
    const c = p.getAttribute && p.getAttribute('class');
    if (c && c.includes('bbCodeBlock--quote')) return true;
  }
  return false;
};

function quoteText(bq) {
  const content = bq.querySelector('.bbCodeBlock-content');
  if (!content) return '';
  content.querySelectorAll('blockquote, .bbCodeBlock-expandLink, .js-expandLink').forEach((n) => n.remove());
  return htmlToText(content.innerHTML)
    .replace(/Click to (expand|shrink)\.\.\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const idOf = (text) => 'wog:sb:' + createHash('sha1').update(text.slice(0, 120)).digest('hex').slice(0, 12);

// Every marker in a post body, in document order: text runs, links (with href +
// anchor text), and top-level quotes (with computed id + snippet).
function richMarkers(wrap) {
  const out = [];
  (function walk(node) {
    for (const c of node.childNodes) {
      if (!c.tagName) {
        const t = (c.text || '').replace(/Click to (expand|shrink)\.\.\./g, '').replace(/\s+/g, ' ').trim();
        if (/[A-Za-z0-9]/.test(t)) out.push({ kind: 'text', text: t });
        continue;
      }
      const tag = c.tagName.toLowerCase();
      const cls = c.getAttribute('class') || '';
      if (tag === 'blockquote' && cls.includes('bbCodeBlock--quote')) {
        const txt = quoteText(c);
        out.push({ kind: 'quote', id: txt ? idOf(txt) : '', snippet: txt.slice(0, 160) });
        continue;
      }
      if (tag === 'a') {
        out.push({ kind: 'link', href: c.getAttribute('href') || '', text: (c.text || '').replace(/\s+/g, ' ').trim() });
        continue;
      }
      walk(c);
    }
  })(wrap);
  return out;
}

function render(ms, targetIdx) {
  const lines = [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.kind === 'text') lines.push(`  text: "${m.text.slice(0, 220)}"`);
    else if (m.kind === 'link') lines.push(`  [LINK → ${m.href}]${m.text ? `  (anchor: "${m.text.slice(0, 60)}")` : ''}`);
    else if (m.kind === 'quote') {
      lines.push(i === targetIdx
        ? `  >>> TARGET QUOTE: "${m.snippet}" <<<`
        : `  quote: "${m.snippet}"`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const records = JSON.parse(await readFile(CORPUS, 'utf8'));
  const targets = new Map(records.filter((r) => r.source === 'WoG Thread').map((r) => [r.id, r]));

  const files = (await readdir(SRC_DIR)).filter((f) => f.endsWith('.html'));
  const handled = new Set();
  const contexts = [];

  for (const file of files) {
    const root = parse(await readFile(join(SRC_DIR, file), 'utf8'));
    for (const wrap of root.querySelectorAll('.bbWrapper')) {
      // Only consider posts that actually hold a still-unhandled target.
      const ms = richMarkers(wrap);
      ms.forEach((m, idx) => {
        if (m.kind !== 'quote' || !targets.has(m.id) || handled.has(m.id)) return;
        handled.add(m.id);
        const rec = targets.get(m.id);
        const lo = Math.max(0, idx - WINDOW), hi = Math.min(ms.length, idx + WINDOW + 1);
        contexts.push({
          id: m.id,
          postUrl: rec.url,
          label: rec.question || '',
          quote: rec.text,
          transcript: render(ms.slice(lo, hi), idx - lo),
          windowed: lo > 0 || hi < ms.length,
        });
      });
    }
  }

  await writeFile(OUT, JSON.stringify(contexts, null, 2));
  console.log(`Wrote ${contexts.length} target contexts to ${OUT} (of ${targets.size} thread-only entries).`);
  const missing = [...targets.keys()].filter((id) => !handled.has(id));
  if (missing.length) console.log(`  ${missing.length} not located in saved HTML:`, missing.slice(0, 5));
}

main().catch((e) => { console.error(e); process.exit(1); });
