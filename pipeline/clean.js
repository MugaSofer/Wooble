// Turn WordPress `content.rendered` HTML into clean plain text, and strip the
// inter-chapter navigation links Wildbow puts at the top and bottom of posts.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToText(html) {
  let t = html;
  t = t.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '');
  // Block-level boundaries become newlines so paragraphs survive.
  t = t.replace(/<\s*br\s*\/?>/gi, '\n');
  t = t.replace(/<\/\s*(p|div|h[1-6]|li|blockquote)\s*>/gi, '\n\n');
  t = t.replace(/<[^>]+>/g, '');
  t = decodeEntities(t);
  // Normalise whitespace: trim each line, collapse runs of blank lines.
  t = t.replace(/[ \t ]+/g, ' ')
       .split('\n')
       .map((line) => line.trim())
       .join('\n')
       .replace(/\n{3,}/g, '\n\n')
       .trim();
  return t;
}

const NAV_PHRASE = /(last chapter|next chapter|previous chapter|first chapter(?: of [^\n]*?)?|table of contents)/gi;

// A line that is nothing but navigation links once the phrases are removed —
// catches both "Next Chapter" alone and combined "Previous Chapter Next Chapter".
function isNavOnly(line) {
  const t = line.trim();
  if (!t || !/[a-z]/i.test(t)) return false;
  return t.replace(NAV_PHRASE, '').replace(/[\s|•·–—-]+/g, '') === '';
}

export function stripNavigation(text) {
  let lines = text.split('\n');
  // Cut the trailing Jetpack share/like/related boilerplate that scraped pages
  // carry inside entry-content (the REST API content doesn't include it).
  const cut = lines.findIndex((l) => /^(share this:|like this:|related\b)/i.test(l.trim()));
  if (cut !== -1) lines = lines.slice(0, cut);
  return lines
    .filter((line) => !isNavOnly(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanContent(html) {
  return stripNavigation(htmlToText(html));
}
