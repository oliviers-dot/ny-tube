// NY TUBE : petit serveur sans dépendance.
//  - sert le front (public/)
//  - /api/feed/<flux> : relais brut d'un flux GTFS-rt (secours si le navigateur ne joint pas la MTA)
//  - /api/trains : relais optionnel des flux GTFS-realtime MTA (décodés, JSON compact).
//    Le front interroge d'abord la MTA directement (CORS autorisé) et ne se sert de ce relais
//    qu'en secours. Le front est donc aussi publiable tel quel sur n'importe quel hébergement statique.
// Lancement : node server.js   puis http://localhost:8080

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { snapshot: buildSnapshot, BASE } = require('./public/lib/gtfsrt');

const PORT = process.env.PORT || 8080;
const MTA_BASE = process.env.MTA_BASE || BASE;
const CACHE_MS = 15000;
const PUB = path.join(__dirname, 'public');

let cache = { at: 0, body: null, gz: null, pending: null };

async function snapshot() {
  if (cache.body && Date.now() - cache.at < CACHE_MS) return cache;
  if (!cache.pending) {
    cache.pending = buildSnapshot(MTA_BASE)
      .then((snap) => {
        const body = Buffer.from(JSON.stringify(snap));
        cache = { at: Date.now(), body, gz: zlib.gzipSync(body), pending: null };
        console.log(new Date().toISOString(), snap.trains.length, 'rames', snap.errors.length ? 'erreurs: ' + snap.errors.join(' | ') : '');
        return cache;
      })
      .catch((e) => { cache.pending = null; throw e; });
  }
  return cache.pending;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const gzCache = new Map();

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    if (/gzip/.test(req.headers['accept-encoding'] || '') && data.length > 2048) {
      if (!gzCache.has(file) || gzCache.get(file).len !== data.length) gzCache.set(file, { len: data.length, gz: zlib.gzipSync(data) });
      headers['Content-Encoding'] = 'gzip';
      data = gzCache.get(file).gz;
    }
    res.writeHead(200, headers).end(data);
  });
}

// /api/feed/<chemin MTA> : relais brut (protobuf) d'un flux, mis en cache 10 s
const feedCache = new Map();
async function relayFeed(name) {
  const c = feedCache.get(name);
  if (c && Date.now() - c.at < 10000) return c.body;
  const res = await fetch(MTA_BASE + name);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = Buffer.from(await res.arrayBuffer());
  feedCache.set(name, { at: Date.now(), body });
  return body;
}

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/feed/')) {
    const name = req.url.slice('/api/feed/'.length).split('?')[0];
    if (!/^[a-z]+%2F[a-z-]+$/i.test(name)) { res.writeHead(400).end(); return; }
    try {
      const body = await relayFeed(name);
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-store' }).end(body);
    } catch (e) {
      res.writeHead(502).end(e.message);
    }
    return;
  }
  if (req.url.startsWith('/api/trains')) {
    try {
      const c = await snapshot();
      const gz = /gzip/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      res.end(gz ? c.gz : c.body);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  serveStatic(req, res);
}).listen(PORT, () => console.log(`NY TUBE sur http://localhost:${PORT}`));
