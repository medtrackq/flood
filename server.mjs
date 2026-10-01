// Static file server plus a cached proxy for POPNIX Flood (https://flood.pop.in.th).
// POPNIX asks heavy users to fetch server-side and cache rather than have every
// browser call it, and its responses do not carry CORS headers.
// No dependencies: `node server.mjs` (PORT defaults to 8080).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const UPSTREAM = 'https://flood.pop.in.th';
const JSON_TTL = 60 * 1000;
const IMG_TTL = 2 * 60 * 1000;
const IMG_MAX = 400; // cached camera images (~30 KB each)

// Camera feeds POPNIX collects. Images live at `${img}${id}.jpg`.
const CAM_FEEDS = {
  cctv: { list: '/cctv/cams.json', img: '/cctv/', org: 'กล้องจราจร กทม.' },
  dds: { list: '/cctv/dds.json', img: '/cctv/dds/', org: 'สำนักการระบายน้ำ กทม.' },
  itic: { list: '/itic/cams.json', img: '/itic/', org: 'iTIC' },
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

// ---------- cached upstream fetch ----------

const cache = new Map(); // path -> { at, body: Buffer, type, pending }

function cached(path, ttl, max = Infinity) {
  const hit = cache.get(path);
  if (hit?.body && Date.now() - hit.at < ttl) return Promise.resolve({ ...hit, cache: 'HIT' });
  if (hit?.pending) return hit.pending;

  const pending = (async () => {
    try {
      const r = await fetch(UPSTREAM + path, {
        headers: { 'User-Agent': 'flood-dashboard (+https://flood.pop.in.th attribution)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw Object.assign(new Error(`upstream ${r.status}`), { status: r.status });
      const entry = { at: Date.now(), body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') };
      cache.delete(path); // re-insert so Map order tracks recency for eviction
      cache.set(path, entry);
      if (cache.size > max) evictImages(max);
      return { ...entry, cache: 'MISS' };
    } catch (err) {
      // Serve the last good copy if we have one, so a flaky upstream doesn't blank the page.
      if (hit?.body) { cache.set(path, { at: hit.at, body: hit.body, type: hit.type }); return { ...hit, cache: 'STALE' }; }
      cache.delete(path);
      throw err;
    }
  })();
  cache.set(path, { ...hit, pending });
  return pending;
}

function evictImages(max) {
  const images = [...cache.keys()].filter((k) => k.endsWith('.jpg'));
  for (const k of images.slice(0, images.length - max)) if (!cache.get(k)?.pending) cache.delete(k);
}

// ---------- camera list ----------

let camsMemo = { stamp: '', body: null, keys: new Set() };

async function cams() {
  const feeds = await Promise.all(Object.entries(CAM_FEEDS).map(async ([feed, f]) => {
    try { return { feed, f, res: await cached(f.list, JSON_TTL) }; } catch { return { feed, f, res: null }; }
  }));
  if (feeds.every((x) => !x.res)) throw new Error('no camera feed available');

  // Rebuild only when a feed body actually changed.
  const stamp = feeds.map((x) => x.res?.at ?? 0).join(',');
  if (camsMemo.stamp === stamp) return camsMemo.body;

  const out = [];
  const keys = new Set();
  let at = 0;
  for (const { feed, f, res } of feeds) {
    if (!res) continue;
    let d;
    try { d = JSON.parse(res.body.toString('utf8')); } catch { continue; }
    at = Math.max(at, Number(d.at) || 0);
    for (const c of d.cams || []) {
      if (c.id == null || !c.img) continue; // no image yet
      keys.add(feed + ':' + c.id);
      out.push({
        f: feed, id: String(c.id), name: c.name || '', detail: c.detail || '',
        org: c.org || f.org, lat: c.lat, lng: c.lng, img: c.img, flood: c.flood ? 1 : 0,
      });
    }
  }
  camsMemo = { stamp, body: Buffer.from(JSON.stringify({ at, cams: out })), keys };
  return camsMemo.body;
}

// ---------- static files ----------

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

// ---------- routes ----------

function sendJSON(res, body, state) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Cache': state });
  res.end(body);
}

function fail(res, where, err) {
  console.error(new Date().toISOString(), where, err.message);
  const status = err.status === 404 ? 404 : 502;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(JSON.stringify({ error: status === 404 ? 'not found' : 'upstream unavailable' }));
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  if (path === '/api/overview') {
    try {
      const r = await cached('/api_overview.php', JSON_TTL);
      sendJSON(res, r.body, r.cache);
    } catch (err) { fail(res, path, err); }
    return;
  }

  if (path === '/api/cams') {
    try { sendJSON(res, await cams(), 'MERGED'); } catch (err) { fail(res, path, err); }
    return;
  }

  // /cam/<feed>/<id>.jpg — only known feeds and plain ids, so nothing else upstream is reachable.
  const m = path.match(/^\/cam\/([a-z]+)\/([A-Za-z0-9_-]{1,64})\.jpg$/);
  if (m) {
    const feed = CAM_FEEDS[m[1]];
    try {
      // Only cameras in the current list, so made-up ids never reach POPNIX.
      if (!camsMemo.body) await cams();
      if (!feed || !camsMemo.keys.has(m[1] + ':' + m[2])) { res.writeHead(404).end(); return; }
      const r = await cached(feed.img + m[2] + '.jpg', IMG_TTL, IMG_MAX);
      // The page adds ?t=<image time> to the URL, so a browser copy can live a while.
      res.writeHead(200, { 'Content-Type': r.type || 'image/jpeg', 'Cache-Control': 'public, max-age=300', 'X-Cache': r.cache });
      res.end(r.body);
    } catch (err) { fail(res, path, err); }
    return;
  }

  await serveStatic(path, res);
}).listen(PORT, () => {
  console.log(`Flood dashboard on http://localhost:${PORT}`);
});
