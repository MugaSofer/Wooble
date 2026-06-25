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

// Lines that are purely inter-chapter navigation, not story text.
const NAV_LINE = /^(last chapter|next chapter|previous chapter|next|previous|table of contents|first chapter[^\n]*|last[^\n]{0,30}\bnext\b[^\n]*)$/i;

export function stripNavigation(text) {
  return text
    .split('\n')
    .filter((line) => !(line && NAV_LINE.test(line.trim())))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanContent(html) {
  return stripNavigation(htmlToText(html));
}
