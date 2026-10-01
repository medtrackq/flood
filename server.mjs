// Static file server plus a cached proxy for the POPNIX Flood open API.
// POPNIX asks heavy users to fetch server-side and cache rather than have every
// browser call it, and its responses do not always carry CORS headers.
// No dependencies: `node server.mjs` (PORT defaults to 8080).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const UPSTREAM = 'https://flood.pop.in.th';
const CACHE_MS = 60 * 1000;

// Local path -> upstream path. Only these are proxied.
const ROUTES = {
  '/api/overview': '/api_overview.php',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const cache = new Map(); // key -> { at, body, pending }

async function upstream(path, search) {
  const key = path + search;
  const hit = cache.get(key);
  if (hit?.body && Date.now() - hit.at < CACHE_MS) return { body: hit.body, cache: 'HIT' };
  if (hit?.pending) return hit.pending;

  const pending = (async () => {
    try {
      const r = await fetch(UPSTREAM + path + search, {
        headers: { 'User-Agent': 'flood-dashboard (+https://flood.pop.in.th attribution)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const body = await r.text();
      cache.set(key, { at: Date.now(), body });
      return { body, cache: 'MISS' };
    } catch (err) {
      // Serve the last good copy if we have one, so a flaky upstream doesn't blank the page.
      if (hit?.body) { cache.set(key, { at: hit.at, body: hit.body }); return { body: hit.body, cache: 'STALE' }; }
      cache.delete(key);
      throw err;
    }
  })();
  cache.set(key, { ...hit, pending });
  return pending;
}

async function serveStatic(pathname, res) {
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (!file.startsWith(ROOT + '/') || /(^|\/)\.|server\.mjs$|package\.json$/.test(file.slice(ROOT.length))) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const route = ROUTES[url.pathname];
  if (route) {
    try {
      const { body, cache: state } = await upstream(route, url.search);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'X-Cache': state,
      });
      res.end(body);
    } catch (err) {
      console.error(new Date().toISOString(), route, err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'upstream unavailable' }));
    }
    return;
  }
  await serveStatic(url.pathname, res);
}).listen(PORT, () => {
  console.log(`Flood dashboard on http://localhost:${PORT}`);
});
