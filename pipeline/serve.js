// Minimal static file server for previewing the built site locally.
//   node pipeline/serve.js   →   http://localhost:8787
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = 'site';
const PORT = 8787;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pf_meta': 'application/octet-stream',
  '.pf_fragment': 'application/octet-stream',
  '.pf_index': 'application/octet-stream',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    // Prevent path traversal outside ROOT.
    const filePath = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache', // always revalidate so edits show up on a normal refresh
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
}).listen(PORT, () => {
  console.log(`Wooble preview running at http://localhost:${PORT}`);
});
