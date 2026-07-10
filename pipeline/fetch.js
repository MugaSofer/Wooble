// Polite, cached fetcher. Caches raw responses to data/raw/ keyed by URL hash,
// rate-limits to one request per second, and backs off on 429 / 5xx.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const UA = 'WoobleBot/0.1 (personal fan search tool; contact mugasofer@gmail.com)';
// Some self-hosted sites (parahumans.net) block non-browser UAs on every route
// with a 403, including the public chapter pages humans read. For those we fall
// back to a browser UA — still rate-limited and cached, just to read public HTML.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CACHE_DIR = 'data/raw';
const MIN_INTERVAL = 1000; // ms between live network requests

let lastRequest = 0;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeWait() {
  const wait = MIN_INTERVAL - (Date.now() - lastRequest);
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
}

function cachePath(url) {
  const h = createHash('sha1').update(url).digest('hex');
  return join(CACHE_DIR, `${h}.json`);
}

const TIMEOUT_MS = 30_000;

// Fetch with retries + backoff. Retries cover 429/5xx responses, thrown network
// errors (DNS blips, connection resets), and hung sockets (30s timeout) — so one
// transient failure mid-crawl doesn't abort a long ingest run.
async function politeFetch(url, headers) {
  let res, lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      lastErr = err;
      res = null;
      continue;
    }
    if (res.status === 429 || res.status >= 500) continue;
    break;
  }
  if (!res) throw lastErr;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

// Returns parsed JSON. Uses on-disk cache unless { fresh: true }.
export async function fetchJSON(url, { fresh = false } = {}) {
  const cp = cachePath(url);
  if (!fresh) {
    try {
      return { fromCache: true, data: JSON.parse(await readFile(cp, 'utf8')) };
    } catch {
      /* cache miss */
    }
  }

  await politeWait();
  const res = await politeFetch(url, { 'User-Agent': UA, Accept: 'application/json' });
  const data = await res.json();
  await mkdir(dirname(cp), { recursive: true });
  await writeFile(cp, JSON.stringify(data));
  return { fromCache: false, data };
}

// Returns raw HTML/text, using a browser UA. Cached separately (.html) from JSON.
export async function fetchText(url, { fresh = false } = {}) {
  const cp = cachePath(url).replace(/\.json$/, '.html');
  if (!fresh) {
    try {
      return { fromCache: true, text: await readFile(cp, 'utf8') };
    } catch {
      /* cache miss */
    }
  }

  await politeWait();
  const res = await politeFetch(url, { 'User-Agent': BROWSER_UA, Accept: 'text/html' });
  const text = await res.text();
  await mkdir(dirname(cp), { recursive: true });
  await writeFile(cp, text);
  return { fromCache: false, text };
}
