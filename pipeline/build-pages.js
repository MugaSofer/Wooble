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
// Genuinely tiny canon, exempt from the word floor: Interlude 27b really is a
// one-sentence chapter ("You needed worthy opponents.") — Worm's shortest.
const FORCE_SERVE = new Set(['https://parahumans.wordpress.com/2013/08/29/interlude-27b/']);

// A few serial chapters are really semi-canon side pieces (April Fool's dream
// chapters, etc.). Reclassify them by canonical URL out of the main serial and
// into Short Fiction; the overrides below are Object.assign-ed onto the record.
const RECLASSIFY = {
  'https://palewebserial.wordpress.com/2021/04/01/far-cry-16-19/': {
    type: 'Reference', work: 'Short Fiction', workSlug: 'short-fiction', tier: 'dream',
    title: "Far Cry 14.12 (April Fool's dream)", docTitle: "Far Cry 14.12 (April Fool's dream)",
  },
};

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Haiku attributes the mixed subreddits' WoG (r/Parahumans = any serial;
// r/Weaverdice = Weaverdice or PactDice) to a serial with a confidence pct. The
// two universe pseudo-labels collapse to a universe token for filtering.
const TAG_TOKEN = { 'Parahumans-universe': 'Parahumans', 'Otherverse-universe': 'Otherverse' };
const tokenOf = (s) => TAG_TOKEN[s] || s;
const TAG_MIN = 40; // pct threshold for a tag to confer filter membership

// One or more filter `category` values per record. Fiction = its work. WoG = its
// source (blog comments kept per-work). Anything cited in the SpaceBattles WoG
// thread ALSO carries the cross-cutting "WoGThread" value, so a cited blog
// comment belongs to both its work and the thread — one record, two memberships.
function categoriesOf(rec) {
  const type = rec.type || 'Fiction';
  // Reference docs: the collection bucket (Weaverdice / PactDice / PRT Quest /
  // Extras) plus its provenance tier, so the UI can filter a whole collection or
  // by canon / semi-canon / fan-made within it.
  if (type === 'Reference') {
    const cats = [`Ref:${rec.work}`, `Ref:${rec.work}:${rec.tier}`];
    // Otherverse shorts get a per-doc filter so Poke/Pâté are separate tree leaves.
    if (rec.work === 'Short Fiction' && rec.tier === 'canon') cats.push(`SFdoc:${rec.docTitle}`);
    // Extras (Other worldbuilding) sub-divide by the serial/setting each doc is about.
    if (rec.work === 'Extras' && rec.setting) cats.push(`Extras:${rec.setting}`);
    return cats;
  }
  if (type !== 'WoG') return [rec.work];
  // Serial pages (FAQ / Cast / About) — his authoritative out-of-story text,
  // grouped by serial. Curated, so served directly (no relevance gate).
  if (rec.source === 'Page') return [`Page:${rec.work}`];
  // PHO Sundays — his in-universe Parahumans-Online roleplay posts. Own category,
  // served directly.
  if (rec.source === 'PHO') return ['PHO'];
  if (rec.source === 'Comment') return rec.cited ? [`Comment:${rec.work}`, 'WoGThread', 'CitedComment'] : [`Comment:${rec.work}`];
  // The bulk Reddit pull is its own WoG source, grouped by subreddit. (Its
  // `cited` flag only exempts it from the canon gate + adds the repository link.)
  if (rec.source === 'Reddit' && String(rec.id).startsWith('wog:reddit:')) {
    const base = ['RedditWoG', `Reddit:${rec.subreddit}`];
    // Attributed serial(s) → filter membership (crossover posts join every serial
    // they're >=TAG_MIN% about; universe-general → a universe token; no signal → Other).
    if (rec.serialTags) {
      let any = false;
      for (const t of rec.serialTags) if (t.pct >= TAG_MIN) { base.push(`WoGtag:${tokenOf(t.serial)}`); any = true; }
      if (!any) base.push('WoGtag:Other');
    }
    return rec.cited ? [...base, 'WoGThread', 'Reddit'] : base; // cited = also quoted in the WoG thread
  }
  // Known origins keep their own bucket; a cited link to some other external
  // site (gdocs, myth-weavers, …) is "Other"; only genuinely linkless entries
  // (an IIRC/PM archived in the thread itself) are "WoGThreadOnly".
  const KNOWN = { Reddit: 'Reddit', SufficientVelocity: 'SufficientVelocity', SpaceBattles: 'SpaceBattles' };
  const origin = KNOWN[rec.source] || (rec.source === 'WoG Thread' ? 'WoGThreadOnly' : 'Other');
  return [origin, 'WoGThread'];
}

function pageHtml(rec) {
  const type = rec.type || 'Fiction';
  const year = rec.date ? rec.date.slice(0, 4) : '';
  const categories = categoriesOf(rec);
  // WoG indexes the question (context) and Wildbow's answer together; fiction
  // indexes the chapter prose. Extra meta lets the UI render WoG distinctly.
  let body, extraMeta = '';
  if (type === 'Reference') {
    body = rec.text.split('\n\n').filter(Boolean).map((p) => `    <p>${esc(p)}</p>`).join('\n');
    extraMeta =
      `    <span data-pagefind-meta="tier">${esc(rec.tier)}</span>\n` +
      `    <span data-pagefind-meta="doc_title">${esc(rec.docTitle ?? '')}</span>\n`;
  } else if (type === 'WoG') {
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
      (rec.subreddit ? `    <span data-pagefind-meta="subreddit">${esc(rec.subreddit)}</span>\n` : '') +
      (rec.serialTags ? `    <span data-pagefind-meta="serial_tags">${esc(JSON.stringify(rec.serialTags.slice(0, 3)))}</span>\n` : '') +
      (rec.wogUrl ? `    <a data-pagefind-meta="wog_url[href]" href="${esc(rec.wogUrl)}">wog</a>\n` : '') +
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
    <span data-pagefind-meta="work">${esc(rec.work)}</span>
    <span data-pagefind-meta="type">${esc(type)}</span>
    ${categories.map((c) => `<span data-pagefind-filter="category">${esc(c)}</span>`).join('\n    ')}
    ${year ? `<span data-pagefind-filter="year">${esc(year)}</span>` : ''}
    <time data-pagefind-meta="date"${rec.date ? ' data-pagefind-sort="date"' : ''}>${esc(rec.date)}</time>
    <a data-pagefind-meta="url[href]" href="${esc(rec.url)}">source</a>
${extraMeta}  </div>
  <main data-pagefind-body>
    <h1 data-pagefind-meta="title">${esc(rec.title)}</h1>
${body}
  </main>
</body>
</html>`;
}

// Trim to a word boundary for the browse listings (mirrors the UI's clip()).
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') : s; };

// A browse-listing entry: everything the UI's result card renders, so a
// query-less browse can be served from static JSON instead of asking Pagefind
// to enumerate the whole index (which is seconds of wasm CPU when cold).
function listingEntry(rec, cats) {
  const type = rec.type || 'Fiction';
  const e = { title: rec.title, url: rec.url, date: rec.date || '', work: rec.work, type, cats };
  if (type === 'WoG') {
    e.source = rec.source ?? 'Comment';
    if (rec.subreddit) e.subreddit = rec.subreddit;
    if (rec.serialTags?.length) e.serialTags = rec.serialTags.slice(0, 3);
    if (rec.wogUrl) e.wogUrl = rec.wogUrl;
    if (rec.parentAuthor) e.askedBy = rec.parentAuthor;
    if (rec.question) e.question = clip(rec.question, 240);
    e.answer = clip(rec.text, 360);
  } else {
    if (rec.tier) e.tier = rec.tier;
    e.excerpt = clip(rec.text, 240);
  }
  return e;
}

async function main() {
  await rm(BUILD_DIR, { recursive: true, force: true });
  // Clear the previous index bundle too: Pagefind hashes fragment filenames by
  // content and doesn't purge old ones, so without this they accumulate across
  // rebuilds and bloat the deploy.
  await rm('site/pagefind', { recursive: true, force: true });
  await rm('site/listings', { recursive: true, force: true });

  // Load every record up front so we can cross-reference before generating.
  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json'));
  const all = [];
  for (const file of files) all.push(...JSON.parse(await readFile(join(CORPUS_DIR, file), 'utf8')));

  // Merge: a blog comment cited in the SpaceBattles WoG thread is already in our
  // corpus (we scraped all of Wildbow's comments), so enrich the scraped record
  // with the repository link and a `cited` flag rather than keep a duplicate.
  // We match two ways: by the cited #comment-N link, and — for thread entries
  // where the contributor gave no link — by the quote text itself, since an
  // identical scraped comment IS the source.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const commentById = new Map();
  const commentTexts = [];
  for (const r of all) {
    if (r.type === 'WoG' && r.source === 'Comment') {
      const m = String(r.url || '').match(/#comment-(\d+)/);
      if (m) commentById.set(m[1], r);
      const n = norm(r.text);
      if (n.length >= 50) commentTexts.push({ n, rec: r });
    } else if (typeof r.id === 'string' && r.id.startsWith('wog:reddit:')) {
      // Index the bulk reddit pull by text too, so a thread citation of a reddit
      // comment whose URL didn't match still merges (was a 393-record dup source).
      const n = norm(r.text);
      if (n.length >= 50) commentTexts.push({ n, rec: r });
    }
  }
  // A thread quote matches a scraped comment that contains its first 200
  // normalized chars verbatim. A unique hit is accepted even for short quotes;
  // a short quote with several hits is ambiguous (a generic phrase) and skipped,
  // while a long quote with several hits is just Wildbow repeating himself.
  const matchComment = (text) => {
    const q = norm(text);
    if (q.length < 40) return null;
    const probe = q.slice(0, 200);
    const hits = commentTexts.filter((c) => c.n.includes(probe));
    if (hits.length === 1) return hits[0].rec;
    if (hits.length > 1 && q.length >= 120) return hits[0].rec;
    return null;
  };
  // Bulk Reddit comments indexed by their reddit comment id, so a repository
  // quote of the same comment merges into the scraped version (no duplicate).
  const bulkReddit = new Map();
  for (const r of all) if (typeof r.id === 'string' && r.id.startsWith('wog:reddit:')) bulkReddit.set(r.id.slice(11), r);

  const records = [];
  const textMerged = [];
  let redditMerged = 0;
  for (const r of all) {
    const fromThread = typeof r.id === 'string' && r.id.startsWith('wog:sb:');
    if (fromThread && r.source === 'Blog') {
      const m = String(r.url || '').match(/#comment-(\d+)/);
      const hit = (m && commentById.get(m[1])) || matchComment(r.text); // id, then text fallback
      if (hit) { hit.cited = true; hit.wogUrl = r.wogUrl; continue; } // merge & drop the dup
      r.source = 'Comment'; r.cited = true; // unmatched citation → a cited Worm comment
    } else if (fromThread && r.source === 'WoG Thread') {
      const hit = matchComment(r.text); // no link given — match the quote verbatim
      if (hit) { hit.cited = true; hit.wogUrl = r.wogUrl || r.url; textMerged.push([r.id, hit.url]); continue; }
      r.cited = true;
    } else if (fromThread && r.source === 'Reddit') {
      // Same reddit comment already in the bulk pull → merge into it (no dup).
      const cid = String(r.url || '').split(/[/?#]/).find((s) => bulkReddit.has(s));
      const hit = (cid && bulkReddit.get(cid)) || matchComment(r.text); // id, then text fallback
      if (hit) { hit.cited = true; hit.wogUrl = r.wogUrl || r.url; redditMerged++; continue; }
      r.cited = true;
    } else if (fromThread) {
      r.cited = true; // every other repository entry is "in the thread"
    }
    records.push(r);
  }
  if (textMerged.length) console.log(`Verbatim-matched ${textMerged.length} linkless thread quotes to scraped comments.`);
  if (redditMerged) console.log(`Merged ${redditMerged} repository reddit quotes into the bulk pull.`);

  // Attach cached Haiku WoG-relevance scores to blog comments.
  let scores = {};
  try { scores = JSON.parse(await readFile('data/wog-scores.json', 'utf8')); } catch { /* not scored yet */ }
  for (const r of records) if (r.type === 'WoG' && (r.source === 'Comment' || r.source === 'Reddit') && scores[r.id]) r.score = scores[r.id];

  // Serial attribution for the mixed-subreddit Reddit WoG (Haiku-tagged).
  let serialTags = {};
  try { serialTags = JSON.parse(await readFile('data/wog-serial-tags.json', 'utf8')); } catch { /* not attributed yet */ }
  // Attach even an empty [] (Haiku found no serial signal) so those attributed
  // records land in an "Other" bucket, distinct from un-attributed subreddits.
  for (const r of records) if (String(r.id).startsWith('wog:reddit:') && serialTags[r.id]) r.serialTags = serialTags[r.id];
  // Sanity filter: a tag for a serial that hadn't been published when the comment
  // was posted is impossible — drop it. Release dates = each serial's earliest
  // chapter date in the corpus (only the 7 serials have one; universe/game tags
  // are left alone).
  const RELEASE = {};
  for (const r of all) if ((r.type || 'Fiction') === 'Fiction' && r.work && r.date && (!RELEASE[r.work] || r.date < RELEASE[r.work])) RELEASE[r.work] = r.date;
  for (const r of records) if (r.serialTags?.length) r.serialTags = r.serialTags.filter((t) => !RELEASE[t.serial] || !r.date || r.date >= RELEASE[t.serial]);

  for (const rec of records) { const o = RECLASSIFY[rec.url]; if (o) Object.assign(rec, o); }

  let total = 0, skipped = 0, droppedNonCanon = 0, droppedFan = 0;
  const years = new Set();
  const fiction = new Map();      // work -> fiction chapter count
  const reference = new Map();    // "collection\ttier" -> reference-section count
  const otherverseShorts = new Map(); // Short-Fiction canon docTitle -> record count
  const extraSettings = new Map();    // Extras setting (serial) -> record count
  const wogComment = new Map();   // work -> blog-comment WoG count
  const blogPages = new Map();    // work -> serial-page (FAQ/Cast/About) count
  const redditWoG = new Map();    // subreddit -> served bulk-reddit WoG count
  const redditSerial = new Map(); // "subreddit\tserialToken" -> served count (by primary tag)
  const servedUntagged = [];      // served reddit ids with no serial tag yet (for a re-attribution pass)
  const threadOrigins = new Map(); // origin -> count, within the WoG thread
  let threadTotal = 0;
  let phoCount = 0;               // PHO Sundays in-universe posts
  const listings = new Map();     // workSlug -> browse-listing entries (served records)
  const listingCats = new Map();  // category -> Set of workSlugs whose listing carries it

  for (const rec of records) {
    const isWoG = (rec.type || 'Fiction') === 'WoG';
    const isRef = rec.type === 'Reference';
    // Ref sections are shorter than chapters; sheet rows (a cape's confirmed
    // affiliation, a vial's stat line) are terser still and shouldn't be culled.
    const floor = isWoG ? 1 : isRef ? (String(rec.id).startsWith('sheet:') ? 5 : 20) : MIN_WORDS;
    if (rec.wordCount < floor && !FORCE_SERVE.has(rec.url)) { skipped++; continue; }
    // Serve curated WoG in full (fiction, repository quotes, cited entries). The
    // Haiku-classified dumps — blog comments and the bulk Reddit pull — are the
    // noisy sources, so they're filtered to the "canon" tag; everything else
    // Haiku tagged stays in the archives (corpus + wog-scores.json), unserved.
    const haikuGated = rec.source === 'Comment' || (rec.source === 'Reddit' && String(rec.id).startsWith('wog:reddit:'));
    if (isWoG && haikuGated && !rec.cited && rec.score?.category !== 'canon') { droppedNonCanon++; continue; }
    // Only Wildbow's own docs are served; community/fan-made reference stays in
    // the archive (corpus file) but isn't indexed. His canon, campaigns, and
    // short-fiction drafts qualify; fan-made / unknown don't.
    if (isRef && !['canon', 'semicanon', 'draft', 'sample', 'story', 'dream', 'uncertain'].includes(rec.tier)) { droppedFan++; continue; }
    const dir = join(BUILD_DIR, rec.workSlug);
    await mkdir(dir, { recursive: true });
    const slug = rec.id.split(':').slice(1).join(':').replace(/[^a-z0-9-]+/gi, '-');
    await writeFile(join(dir, `${slug}.html`), pageHtml(rec));
    total++;
    const recCats = categoriesOf(rec);
    // Bucket WoG separately from its serial (wog-worm vs worm): most WoG shares
    // its chapter's workSlug, and folding it in would make a fiction-only browse
    // download megabytes of comments it doesn't show. The reddit pull and the SB
    // thread get their own buckets too, so no single browse fetches everything.
    const bucket = !isWoG ? rec.workSlug
      : String(rec.id).startsWith('wog:reddit:') ? 'wog-reddit'
      : String(rec.id).startsWith('wog:sb:') ? 'wog-thread'
      : `wog-${rec.workSlug}`;
    if (!listings.has(bucket)) listings.set(bucket, []);
    listings.get(bucket).push(listingEntry(rec, recCats));
    for (const c of recCats) {
      if (!listingCats.has(c)) listingCats.set(c, new Set());
      listingCats.get(c).add(bucket);
    }
    if (rec.date) years.add(rec.date.slice(0, 4));
    if (isRef) {
      const k = rec.work + '\t' + rec.tier; reference.set(k, (reference.get(k) ?? 0) + 1);
      if (rec.work === 'Short Fiction' && rec.tier === 'canon') otherverseShorts.set(rec.docTitle, (otherverseShorts.get(rec.docTitle) ?? 0) + 1);
      if (rec.work === 'Extras' && rec.setting) extraSettings.set(rec.setting, (extraSettings.get(rec.setting) ?? 0) + 1);
      continue;
    }
    if (!isWoG) { fiction.set(rec.work, (fiction.get(rec.work) ?? 0) + 1); continue; }
    if (rec.source === 'PHO') phoCount++;
    if (rec.source === 'Page') blogPages.set(rec.work, (blogPages.get(rec.work) ?? 0) + 1);
    if (rec.source === 'Comment') wogComment.set(rec.work, (wogComment.get(rec.work) ?? 0) + 1);
    if (rec.source === 'Reddit' && String(rec.id).startsWith('wog:reddit:')) {
      redditWoG.set(rec.subreddit, (redditWoG.get(rec.subreddit) ?? 0) + 1);
      const primary = rec.serialTags?.length ? tokenOf(rec.serialTags[0].serial) : 'Other';
      const k = rec.subreddit + '\t' + primary; redditSerial.set(k, (redditSerial.get(k) ?? 0) + 1);
      if (!rec.serialTags?.length) servedUntagged.push(rec.id); // served but not yet attributed
    }
    if (recCats.includes('WoGThread')) {
      threadTotal++;
      const origin = recCats.find((c) => c !== 'WoGThread' && c !== 'RedditWoG' && !c.startsWith('Comment:') && !c.startsWith('Reddit:'));
      if (origin) threadOrigins.set(origin, (threadOrigins.get(origin) ?? 0) + 1);
    }
  }

  const ORDER = ['Worm', 'Pact', 'Twig', 'Ward', 'Pale', 'Claw', 'Seek'];
  const byWork = (a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]);
  const ORIGIN_ORDER = ['CitedComment', 'Reddit', 'SufficientVelocity', 'SpaceBattles', 'Other', 'WoGThreadOnly'];
  const SUB_ORDER = ['Parahumans', 'Weaverdice', 'whowouldwin', 'WormFanfic'];
  const TIER_ORDER = ['canon', 'semicanon', 'dream', 'story', 'sample', 'draft', 'uncertain', 'fanmade', 'unknown'];
  const REF_ORDER = ['Weaverdice', 'PactDice', 'PRT Quest', 'Short Fiction', 'Game Concepts', 'Extras'];
  const EXTRA_SETTING_ORDER = ['Parahumans', 'Twig', 'Ward', 'Pale'];
  const meta = {
    fiction: [...fiction].sort(byWork),
    reference: [...reference].map(([k, c]) => { const [w, t] = k.split('\t'); return [w, t, c]; })
      .sort((a, b) => (REF_ORDER.indexOf(a[0]) - REF_ORDER.indexOf(b[0])) || (TIER_ORDER.indexOf(a[1]) - TIER_ORDER.indexOf(b[1]))),
    otherverseShorts: [...otherverseShorts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    extraSettings: [...extraSettings].sort((a, b) => (EXTRA_SETTING_ORDER.indexOf(a[0]) + 1 || 99) - (EXTRA_SETTING_ORDER.indexOf(b[0]) + 1 || 99)),
    wogComment: [...wogComment].sort(byWork),
    blogPages: [...blogPages].sort(byWork),
    pho: phoCount,
    reddit: [...redditWoG].sort((a, b) => SUB_ORDER.indexOf(a[0]) - SUB_ORDER.indexOf(b[0])),
    redditSerial: [...redditSerial].map(([k, c]) => { const [s, t] = k.split('\t'); return [s, t, c]; }).sort((a, b) => b[2] - a[2]),
    wogThread: { total: threadTotal, origins: [...threadOrigins].sort((a, b) => ORIGIN_ORDER.indexOf(a[0]) - ORIGIN_ORDER.indexOf(b[0])) },
    years: [...years].sort(),
    items: total,
    // Browse listings: which listing files carry each category, so the UI can
    // fetch just the files a source selection needs (and all of them for a
    // sort-only "everything" browse).
    listings: Object.fromEntries([...listingCats].map(([c, slugs]) => [c, [...slugs]])),
    listingSlugs: [...listings.keys()],
  };
  await mkdir('site', { recursive: true });
  await writeFile(join('site', 'meta.json'), JSON.stringify(meta));
  await mkdir('site/listings', { recursive: true });
  for (const [slug, entries] of listings) await writeFile(join('site/listings', `${slug}.json`), JSON.stringify(entries));
  await writeFile('data/wog-served-untagged.json', JSON.stringify(servedUntagged));

  console.log(`Wrote ${total} pages to ${BUILD_DIR}/ (skipped ${skipped} short, ${droppedNonCanon} non-canon comments + ${droppedFan} fan-made docs archived).`);
  console.log(`meta.json: ${meta.fiction.length} works, Reference [${meta.reference.map((r) => r.join(':')).join(', ')}], ${meta.wogComment.length} comment-works, reddit [${meta.reddit.map((r) => r.join(':')).join(', ')}], WoG-thread ${threadTotal} (${meta.wogThread.origins.map((o) => o.join(':')).join(', ')}), years ${meta.years[0]}–${meta.years.at(-1)}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
