// Ingest Wildbow's Google Sheets into the corpus.
//
//   * parahumanList — a fan-maintained cape roster (name / power / affiliation /
//     classification) in which Wildbow's OWN canonical entries are set in bold.
//     We serve only his bolded rows and note per-field which values are his
//     Word of God, leaving the community-filled rows unserved.
//   * Cauldron Vials — his catalogue of Cauldron's vial formulas; the whole
//     sheet is his, so every vial is served as canon.
//
// Sheets export loses formatting via CSV/HTML (the HTML export is a stub), so we
// pull the XLSX and read the bold runs straight out of the OOXML — bold is the
// only signal separating Wildbow's canon from fan guesses in the cape list.
import { mkdir, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const UA = 'wooble-fan-archive/0.1 (personal WoG search project)';
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

// --- minimal zip reader (Node has no bundled unzip) ---------------------------
// Walk the central directory, inflate each stored/deflated entry into a buffer.
function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip');
  let p = buf.readUInt32LE(e + 16);
  const count = buf.readUInt16LE(e + 10);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const cs = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(lo + 26), lel = buf.readUInt16LE(lo + 28);
    const ds = lo + 30 + lnl + lel;
    const data = buf.slice(ds, ds + cs);
    out[name] = method === 8 ? inflateRawSync(data) : data;
    p += 46 + nl + el + cl;
  }
  return out;
}

async function fetchXlsx(id) {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + id);
  return unzip(Buffer.from(await r.arrayBuffer()));
}

const unent = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#10;/g, '\n').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

// Read a worksheet into { rowNumber: { colLetter: { val, bold } } }. `bold` is
// whether the cell's style points at a bold font (styles.xml <fonts>/<cellXfs>).
function readSheet(z, sheetPath = 'xl/worksheets/sheet1.xml') {
  const styles = z['xl/styles.xml'].toString();
  const sheet = z[sheetPath].toString();
  const ss = (z['xl/sharedStrings.xml'] || Buffer.from('')).toString();
  const fonts = [...styles.matchAll(/<font>([\s\S]*?)<\/font>/g)].map((m) => /<b\/>|<b[ >]/.test(m[1]));
  const cxfs = (styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [, ''])[1];
  const xfBold = [...cxfs.matchAll(/<xf [^>]*fontId="(\d+)"/g)].map((m) => !!fonts[+m[1]]);
  const strings = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => unent([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const rows = {};
  for (const m of sheet.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*)>(?:<v>([^<]*)<\/v>)?/g)) {
    const [, col, rn, attr, raw] = m;
    const s = (attr.match(/s="(\d+)"/) || [])[1];
    const bold = s !== undefined && !!xfBold[+s];
    const isStr = /t="s"/.test(attr);
    let val = '';
    if (raw !== undefined && raw !== '') val = isStr ? (strings[+raw] || '') : raw;
    val = String(val).trim();
    (rows[+rn] = rows[+rn] || {})[col] = { val, bold };
  }
  return rows;
}

const rowLink = (id, row) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0&range=A${row}`;

const records = [];

// --- parahumanList: serve only Wildbow's bolded rows --------------------------
// Columns: A real name · B cape name · C power · D affiliation · E classification.
const PLIST = '1pgn9rgYutpBqJg1lSBP3NHnq9WK4ToLq9K4ys_I4cRc';
{
  const rows = readSheet(await fetchXlsx(PLIST));
  const FIELDS = [['C', 'Power'], ['D', 'Affiliation'], ['E', 'Classification']];
  let served = 0;
  for (const rn of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
    if (rn === 1) continue; // header
    const c = rows[rn];
    const get = (k) => (c[k] || { val: '', bold: false });
    const name = get('B').val;
    if (!name) continue;
    // A row is Wildbow's canon iff he bolded any of its cells.
    const wb = [];
    if (get('A').bold && get('A').val) wb.push('real name');
    for (const [k, label] of FIELDS) if (get(k).bold && get(k).val) wb.push(label.toLowerCase());
    if (!wb.length) continue; // community-filled row → leave unserved
    const real = get('A').val;
    const lines = FIELDS.map(([k, label]) => (get(k).val ? `${label}: ${get(k).val}` : '')).filter(Boolean);
    lines.push(`Wildbow-confirmed (Word of God): ${wb.join(', ')}.`);
    const text = lines.join('\n\n');
    records.push({
      id: `sheet:plist:${rn}`, work: 'Extras', workSlug: 'extras', type: 'Reference',
      tier: 'canon', docTitle: 'Parahuman Classification List',
      title: real ? `${name} (${real})` : name,
      heading: name, text, url: rowLink(PLIST, rn), date: '', wordCount: words(text),
    });
    served++;
  }
  process.stderr.write(`  parahumanList: ${served} Wildbow-canon capes\n`);
}

// --- Cauldron Vials: whole sheet is Wildbow's, serve every vial ---------------
// Columns: A vial · B label · C description · D classification · E notes · F picked-by · G #picks.
const VIALS = '1g550q_InlHWmMsyYoATYCtnxkqUDWtn_y4KkVynVsA0';
{
  const rows = readSheet(await fetchXlsx(VIALS));
  const FIELDS = [['C', 'Description'], ['D', 'Classification'], ['E', 'Notes'], ['F', 'Picked by']];
  let served = 0;
  for (const rn of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
    if (rn === 1) continue; // header
    const c = rows[rn];
    const v = (k) => (c[k]?.val || '');
    const name = v('A');
    if (!name) continue;
    const label = v('B');
    const lines = FIELDS.map(([k, l]) => (v(k) ? `${l}: ${v(k)}` : '')).filter(Boolean);
    const text = lines.join('\n\n');
    if (!text) continue;
    records.push({
      id: `sheet:vials:${rn}`, work: 'Extras', workSlug: 'extras', type: 'Reference',
      tier: 'canon', docTitle: 'Cauldron Vials',
      title: label ? `${name} — Cauldron vial ${label}` : `${name} — Cauldron vial`,
      heading: name, text, url: rowLink(VIALS, rn), date: '', wordCount: words(text),
    });
    served++;
  }
  process.stderr.write(`  Cauldron Vials: ${served} vials\n`);
}

await mkdir('data/corpus', { recursive: true });
await writeFile('data/corpus/sheets.json', JSON.stringify(records, null, 2));
console.log(`\n${records.length} sheet records, ${records.reduce((s, r) => s + r.wordCount, 0).toLocaleString()} words.`);
