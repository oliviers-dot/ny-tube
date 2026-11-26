/* NY TUBE : métro de New York, LIRR et Metro-North en temps réel.
 * Métro : la MTA publie les heures d'arrivée prévues (pas de GPS). Pour chaque rame on reconstruit
 * une frise horaire (station précédente -> arrêts suivants) et on interpole la position le long du
 * tracé réel, image par image.
 * LIRR / Metro-North : positions GPS du flux, lissées entre deux relevés. */
'use strict';

const POLL_MS = 10000;        // les flux MTA changent toutes les 15 à 30 s : on regarde toutes les 10 s
const CORR_S = 6;             // durée du rattrapage en douceur d'un train GPS
const ALERTS_MS = 60000;
const MANHATTAN = { center: [-73.975, 40.758], zoom: 12.1, bearing: -29 };
const STYLE = 'https://tiles.openfreemap.org/styles/dark';
const FONT = ['Noto Sans Bold'];

const GROUP = { '6X': '6', '7X': '7', FX: 'F', GS: 'S', FS: 'S', H: 'S', SS: 'SI' };
const LABEL = { GS: 'S', FS: 'S', H: 'S', SI: 'SIR', SS: 'SIR' };
const ORDER = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'S', 'SI'];
const RAIL_FEEDS = { LIRR: 'lirr%2Fgtfs-lirr', MNR: 'mnr%2Fgtfs-mnr' };
// flux GTFS-rt de chaque ligne : seuls les flux des lignes allumées sont téléchargés
const SUB_FEED = { '1': 'gtfs', '2': 'gtfs', '3': 'gtfs', '4': 'gtfs', '5': 'gtfs', '6': 'gtfs', '7': 'gtfs', S: ['gtfs', 'gtfs-ace'],
  A: 'gtfs-ace', C: 'gtfs-ace', E: 'gtfs-ace', B: 'gtfs-bdfm', D: 'gtfs-bdfm', F: 'gtfs-bdfm', M: 'gtfs-bdfm', G: 'gtfs-g',
  J: 'gtfs-jz', Z: 'gtfs-jz', L: 'gtfs-l', N: 'gtfs-nqrw', Q: 'gtfs-nqrw', R: 'gtfs-nqrw', W: 'gtfs-nqrw', SI: 'gtfs-si' };
const LEGEND_ROWS = [['1', '2', '3'], ['4', '5', '6'], ['7'], ['A', 'C', 'E'], ['B', 'D', 'F', 'M'], ['G'], ['J', 'Z'], ['L'], ['N', 'Q', 'R', 'W'], ['S', 'SI']];

let S = null, R = null;      // données statiques métro / trains régionaux
let stationById = {};
let pred = {};
let trains = new Map();      // métro
let rail = new Map();        // LIRR / MNR
let alerts = [];
let clockOffset = 0;
const active = new Set();     // lignes de métro allumées (groupes) : tout est éteint au départ
const railActive = new Set(); // branches régionales allumées : "LIRR:1", "MNR:2"…
let focus = null;             // ligne détaillée dans le panneau de droite
let mode = 'plan';
let popupTrain = null, cardKind = null;
let cabTrain = null, cabBearing = null;
const feedState = new Map();  // flux -> { ts, at, err, loading }
let railGeo = [];             // tracés régionaux préparés pour le calage des positions GPS

const nowS = () => Date.now() / 1000 + clockOffset;
const routeOf = (r) => S.routes[r] || S.routes[GROUP[r]] || { color: '#808183', text: '#ffffff', name: r, long: '' };
const routeColor = (r) => routeOf(r).color;
const routeText = (r) => routeOf(r).text;
const label = (r) => LABEL[r] || (r || '?').replace(/X$/, '');
const group = (r) => GROUP[r] || r;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- géométrie
const KX = Math.cos(40.75 * Math.PI / 180);
const M_LAT = 110540, M_LON = 111320 * KX;
function seglen(a, b) { const dx = (a[0] - b[0]) * KX, dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); }
function bearingOf(dir) { return (Math.atan2(dir[0] * KX, dir[1]) * 180) / Math.PI; }
function unit(dir) { const x = dir[0] * KX, y = dir[1]; const n = Math.hypot(x, y) || 1; return [x / n, y / n]; }

const segCache = new Map();
function segment(a, b) {
  const k = a + '>' + b;
  let s = segCache.get(k);
  if (s) return s;
  let pts, t;
  if (S.segments[k]) { pts = S.segments[k].p; t = S.segments[k].t; }
  else if (S.segments[b + '>' + a]) { pts = S.segments[b + '>' + a].p.slice().reverse(); t = S.segments[b + '>' + a].t; }
  else {
    const A = stationById[a], B = stationById[b];
    if (!A || !B) return null;
    pts = [[A.lon, A.lat], [B.lon, B.lat]];
    t = Math.max(60, seglen(pts[0], pts[1]) / 0.0001 * 9);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + seglen(pts[i - 1], pts[i]));
  s = { pts, cum, len: cum[cum.length - 1], t };
  segCache.set(k, s);
  return s;
}

function along(seg, f) {
  const d = f * seg.len;
  let i = 1;
  while (i < seg.cum.length - 1 && seg.cum[i] < d) i++;
  const a = seg.pts[i - 1], b = seg.pts[i];
  const span = seg.cum[i] - seg.cum[i - 1] || 1;
  const u = Math.min(1, Math.max(0, (d - seg.cum[i - 1]) / span));
  return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], dir: [b[0] - a[0], b[1] - a[1]] };
}

// décalage latéral vers la droite du sens de marche (sépare les deux voies), appliqué aussi à quai
function offsetRight(p, dir, m = 30) {
  const [ux, uy] = unit(dir);
  return [p[0] + (uy * m) / M_LON, p[1] - (ux * m) / M_LAT];
}

// rectangle orienté pour la 3D (longueur et largeur en mètres)
function box(p, dir, len, wid) {
  const [ux, uy] = unit(dir);
  const pt = (a, b) => [p[0] + (ux * a + uy * b) / M_LON, p[1] + (uy * a - ux * b) / M_LAT];
  const L = len / 2, W = wid / 2;
  return [[pt(L, -W), pt(L, W), pt(-L, W), pt(-L, -W), pt(L, -W)]];
}

// ---------- composition des rames
// Les flux MTA ne publient pas la composition réelle (champ GTFS-rt multi_carriage_details absent,
// vérifié le 26/11/2026). On utilise la composition standard de chaque ligne : [nombre de voitures, longueur d'une voiture en m].
const CARS = { '1': [10, 15.5], '2': [10, 15.5], '3': [10, 15.5], '4': [10, 15.5], '5': [10, 15.5], '6': [10, 15.5], '6X': [10, 15.5],
  '7': [11, 15.5], '7X': [11, 15.5], B: [8, 22.9], D: [8, 22.9], N: [8, 22.9], Q: [8, 22.9], A: [8, 22.9],
  C: [10, 18.3], E: [10, 18.3], F: [10, 18.3], FX: [10, 18.3], R: [10, 18.3], W: [10, 18.3],
  M: [8, 18.3], J: [8, 18.3], Z: [8, 18.3], L: [8, 18.3], G: [5, 18.3], GS: [6, 15.5], FS: [2, 22.9], H: [4, 22.9], SI: [4, 22.9] };
const RAIL_CARS = { LIRR: [10, 25.9], MNR: [8, 25.9] };

// une boîte par voiture (caisse + toit plus clair), le long du sens de marche
function pushCars(out, p, dir, n, len, color, id, k) {
  const [ux, uy] = unit(dir);
  const gap = 1.2, total = n * len + (n - 1) * gap;
  for (let i = 0; i < n; i++) {
    const off = -total / 2 + len / 2 + i * (len + gap);
    const c = [p[0] + (ux * off) / M_LON, p[1] + (uy * off) / M_LAT];
    out.push({ type: 'Feature', properties: { k, id, c: color, h: 5, b: 0.6 }, geometry: { type: 'Polygon', coordinates: box(c, dir, len, 4.2) } });
    out.push({ type: 'Feature', properties: { k, id, c: '#b9bdc4', h: 5.6, b: 5 }, geometry: { type: 'Polygon', coordinates: box(c, dir, len * 0.55, 2.2) } });
  }
}

// ---------- frises horaires du métro
function patternKey(tripId) { return tripId.split('_').pop(); }
function routeDirOf(key) { const m = /^([^.]+)\.+([NS])/.exec(key); return m ? m[1] + '|' + m[2] : null; }

function prevStation(t, first) {
  const pat = S.patterns[patternKey(t.id)];
  if (pat) {
    const i = pat.indexOf(first);
    if (i > 0) return pat[i - 1];
    if (i === 0) return null;
  }
  const p = pred[t.r + '|' + t.d] || pred[group(t.r) + '|' + t.d];
  return p ? p[first] || null : null;
}

function destination(t) {
  const pat = S.patterns[patternKey(t.id)];
  const last = t.s.length ? t.s[t.s.length - 1][0] : pat && pat[pat.length - 1];
  return (stationById[last] || {}).name || last || '';
}

function buildTimeline(t, now) {
  const stops = t.s.filter((x) => stationById[x[0]] && (x[1] || x[2]));
  if (!stops.length) return null;
  const pts = stops.map(([id, arr, dep]) => ({ id, arr: arr || dep, dep: Math.max(dep || arr, arr || dep) }));
  const first = pts[0];
  const stopped = t.st === 1 && t.vs === first.id;
  if (stopped) {
    first.arr = Math.min(first.arr, now);
  } else {
    if (first.arr < now - 600) return null;
    const prev = (t.st === 1 && t.vs && t.vs !== first.id && stationById[t.vs]) ? t.vs : prevStation(t, first.id);
    if (prev && stationById[prev]) {
      const seg = segment(prev, first.id);
      const run = seg ? seg.t : 90;
      pts.unshift({ id: prev, arr: first.arr - run - 30, dep: first.arr - run });
    } else if (t.st == null && first.dep - now > 60) {
      return null;
    }
  }
  return pts;
}

function position(tr, now) {
  const tl = tr.tl;
  if (!tl) return null;
  const at = (i) => {
    const A = stationById[tl[i].id];
    // à quai : orientation de la voie (segment suivant, sinon précédent), sans déplacement
    const sg = tl[i + 1] ? segment(tl[i].id, tl[i + 1].id) : (i > 0 ? segment(tl[i - 1].id, tl[i].id) : null);
    const dir = sg ? (tl[i + 1] ? along(sg, 0.02).dir : along(sg, 0.98).dir) : null;
    return { p: [A.lon, A.lat], dir, still: true, at: tl[i].id, from: tl[i].id, next: tl[i + 1] ? tl[i + 1].id : null, f: 0 };
  };
  if (now < tl[0].dep) return at(0);
  for (let i = 0; i < tl.length - 1; i++) {
    const a = tl[i], b = tl[i + 1];
    if (now <= a.dep) return at(i);
    if (now < b.arr) {
      const seg = segment(a.id, b.id);
      if (!seg) continue;
      let f = (now - a.dep) / Math.max(1, b.arr - a.dep);
      f = 0.55 * f + 0.45 * (0.5 - 0.5 * Math.cos(Math.PI * f));
      const r = along(seg, f);
      return { p: r.p, dir: r.dir, from: a.id, next: b.id, f };
    }
  }
  const L = tl[tl.length - 1];
  if (now - L.arr > 120) return null;
  return at(tl.length - 1);
}

const effTime = (tr, now) => now + tr.off * Math.max(0, 1 - (now - tr.offAt) / tr.offDur);

// ---------- chargement
async function loadStatic() {
  const [s, r] = await Promise.all([fetch('data/static.json').then((x) => x.json()), fetch('data/rail.json').then((x) => x.json())]);
  S = s; R = r;
  for (const st of S.stations) stationById[st.id] = st;
  const counts = {};
  for (const [key, list] of Object.entries(S.patterns)) {
    const rd = routeDirOf(key);
    if (!rd) continue;
    for (let i = 1; i < list.length; i++) {
      const k = rd + '|' + list[i];
      counts[k] = counts[k] || {};
      counts[k][list[i - 1]] = (counts[k][list[i - 1]] || 0) + list.length;
    }
  }
  for (const [k, c] of Object.entries(counts)) {
    const [rt, d, st] = k.split('|');
    const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
    (pred[rt + '|' + d] = pred[rt + '|' + d] || {})[st] = best;
  }
}

// ---------- flux temps réel : uniquement ceux des lignes allumées
function neededFeeds() {
  const f = new Set();
  for (const g of active) for (const x of [].concat(SUB_FEED[g] || [])) f.add('nyct%2F' + x);
  for (const k of railActive) f.add(RAIL_FEEDS[k.split(':')[0]]);
  return f;
}
const agOfFeed = (name) => Object.keys(RAIL_FEEDS).find((a) => RAIL_FEEDS[a] === name);

// le navigateur interroge la MTA directement ; en secours, le relais du serveur local (?src=api)
let viaRelay = new URLSearchParams(location.search).get('src') === 'api';
async function fetchFeedAny(name) {
  if (viaRelay) return GTFSRT.fetchFeed(name, 'api/feed/');
  try { return await GTFSRT.fetchFeed(name); }
  catch (e) {
    try { const f = await GTFSRT.fetchFeed(name, 'api/feed/'); viaRelay = true; return f; } catch { throw e; }
  }
}

let pollTimer = null;
function schedulePoll(delay = 0) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await poll();
    schedulePoll(POLL_MS);
  }, delay);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0); });

async function poll() {
  const need = neededFeeds();
  for (const [id, tr] of trains) if (!need.has(tr.feed)) trains.delete(id);
  for (const [id, t] of rail) if (!need.has(RAIL_FEEDS[t.ag])) rail.delete(id);
  for (const f of [...feedState.keys()]) if (!need.has(f)) feedState.delete(f);
  await Promise.all([...need].map(loadFeed));
}

async function loadFeed(name) {
  let st = feedState.get(name);
  if (!st) feedState.set(name, (st = { ts: 0, at: 0, err: null, loading: false }));
  if (st.loading) return;
  st.loading = true; renderLegendState();
  try {
    const feed = await fetchFeedAny(name);
    if (!neededFeeds().has(name)) return;     // ligne éteinte entre-temps
    st.err = null; st.at = nowS();
    if (st.ts && feed.timestamp === st.ts) return; // flux inchangé : on laisse les rames filer
    st.ts = feed.timestamp || Math.floor(st.at);
    const ag = agOfFeed(name);
    if (ag) ingestRail(ag, feed); else ingestSubway(name, feed);
  } catch (e) {
    st.err = e.message || 'erreur';
    console.warn('flux', name, e);
  } finally {
    st.loading = false; renderLegendState();
  }
}

function ingestSubway(name, feed) {
  const now = nowS();
  const seen = new Set();
  for (const t of GTFSRT.trainsFromFeed(feed)) { seen.add(t.id); ingestTrain(t, now, name); }
  for (const [id, tr] of trains) if (tr.feed === name && !seen.has(id)) trains.delete(id);
}

function ingestTrain(t, now, feedName) {
  const old = trains.get(t.id);
  const tr = { ...t, feed: feedName, head: old && old.head, shown: old && old.shown, off: 0, offAt: now, offDur: 20 };
  tr.tl = buildTimeline(t, now);
  if (old && old.shown && tr.tl) {
    // instant de la nouvelle frise où la rame est là où on l'affiche déjà : aucune téléportation,
    // l'écart est rattrapé en accélérant ou ralentissant doucement (jamais de marche arrière)
    const dist = (dt) => {
      const q = position(tr, now + dt);
      if (!q) return Infinity;
      const h = q.dir || tr.head;
      return seglen(h ? offsetRight(q.p, h) : q.p, old.shown) + Math.abs(dt) * 2e-7;
    };
    let best = 0, bd = dist(0);
    if (bd > 0.00005) for (let dt = -150; dt <= 150; dt += 3) { const d = dist(dt); if (d < bd) { bd = d; best = dt; } }
    if (bd > 0.00005) for (let dt = best - 3; dt <= best + 3; dt += 0.2) { const d = dist(dt); if (d < bd) { bd = d; best = dt; } }
    if (bd < 0.006) { tr.off = best; tr.offDur = Math.max(20, Math.abs(best) * 1.5); }
  }
  trains.set(t.id, tr);
}

// ---------- trains régionaux : GPS calé sur les voies, puis avance à la vitesse mesurée entre deux relevés
function prepRailGeo() {
  railGeo = R.lines.map((l) => {
    const cum = [0];
    for (let i = 1; i < l.p.length; i++) cum.push(cum[i - 1] + seglen(l.p[i - 1], l.p[i]));
    return { a: l.a, r: String(l.r), pts: l.p, cum, len: cum[cum.length - 1] };
  });
}

function snapRail(p, ag, routeId) {
  let best = null;
  for (let pass = 0; pass < 2 && !best; pass++) {
    railGeo.forEach((L, li) => {
      if (L.a !== ag || (pass === 0 && routeId && L.r !== routeId)) return;
      for (let i = 1; i < L.pts.length; i++) {
        const A = L.pts[i - 1], B = L.pts[i];
        const ax = (B[0] - A[0]) * KX, ay = B[1] - A[1], px = (p[0] - A[0]) * KX, py = p[1] - A[1];
        const l2 = ax * ax + ay * ay;
        const u = l2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / l2)) : 0;
        const dx = px - ax * u, dy = py - ay * u, d = dx * dx + dy * dy;
        if (!best || d < best.d) best = { d, li, s: L.cum[i - 1] + (L.cum[i] - L.cum[i - 1]) * u };
      }
    });
    if (best && Math.sqrt(best.d) * M_LAT > 250) best = null; // trop loin d'un tracé connu : GPS brut
  }
  return best;
}

function alongLine(L, s) {
  let lo = 1, hi = L.cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (L.cum[m] < s) lo = m + 1; else hi = m; }
  const a = L.pts[lo - 1], b = L.pts[lo];
  const span = L.cum[lo] - L.cum[lo - 1] || 1;
  const u = Math.max(0, Math.min(1, (s - L.cum[lo - 1]) / span));
  return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], dir: [b[0] - a[0], b[1] - a[1]] };
}

// position affichée d'un train GPS (sans le rattrapage)
function railModel(t, now) {
  const f = t.fix;
  if (f.li == null) return { p: f.p, dir: null };
  const L = railGeo[f.li];
  const dt = Math.max(0, Math.min(now - f.t, t.maxEx));
  const q = alongLine(L, Math.max(0, Math.min(L.len, f.s + t.v * dt)));
  return { p: q.p, dir: t.v < 0 ? [-q.dir[0], -q.dir[1]] : t.v > 0 ? q.dir : null };
}

function railPos(t, now) {
  const m = railModel(t, now);
  const k = Math.max(0, 1 - (now - t.corrAt) / t.corrDur);
  const e = k * k * (3 - 2 * k);
  return { p: [m.p[0] + t.corr[0] * e, m.p[1] + t.corr[1] * e], dir: m.dir };
}

function ingestRail(ag, feed) {
  const now = nowS();
  const tus = new Map();
  for (const tu of feed.trips) if (tu.trip) { tus.set(tu.trip.trip_id, tu); if (tu.eid) tus.set('e' + tu.eid, tu); }
  const seen = new Set();
  for (const v of feed.vehicles) {
    if (!v.position || !v.position.lat) continue;
    const id = ag + ':' + (v.eid || (v.trip && v.trip.trip_id));
    seen.add(id);
    const tu = (v.trip && tus.get(v.trip.trip_id)) || tus.get('e' + v.eid) || null;
    const routeId = String((v.trip && v.trip.route_id) || (tu && tu.trip.route_id) || '');
    const stops = tu ? tu.stops : [];
    const lastStop = stops.length ? stops[stops.length - 1].stop_id : null;
    const nextStop = stops.find((u) => (u.arrival || u.departure || 0) >= now - 30);
    const meta = {
      id, ag, routeId,
      num: ag === 'MNR' ? (v.eid || (v.vehicle && v.vehicle.label)) : ((v.trip && v.trip.trip_id) || '').split('_').pop(),
      delay: nextStop ? (nextStop.arr_delay ?? nextStop.dep_delay ?? null) : (tu ? tu.delay ?? null : null),
      dest: lastStop, next: nextStop ? nextStop.stop_id : null, nextT: nextStop ? (nextStop.arrival || nextStop.departure) : null,
      bearing: v.position.bearing,
    };
    const cur = [v.position.lon, v.position.lat];
    const ft = Math.min(now, v.timestamp || feed.timestamp || now);
    const old = rail.get(id);
    if (old && old.raw[0] === cur[0] && old.raw[1] === cur[1]) { Object.assign(old, meta); continue; } // même relevé
    const sn = snapRail(cur, ag, routeId);
    const t = { ...meta, raw: cur, fix: sn ? { p: alongLine(railGeo[sn.li], sn.s).p, t: ft, li: sn.li, s: sn.s } : { p: cur, t: ft, li: null },
      v: 0, maxEx: 0, corr: [0, 0], corrAt: now, corrDur: CORR_S, dir: old && old.dir, shownP: old && old.shownP };
    if (old && old.fix) {
      const dt = ft - old.fix.t;
      if (dt > 2 && dt < 300 && sn && old.fix.li === sn.li) {
        const v0 = (sn.s - old.fix.s) / dt, ms = Math.abs(v0) * M_LAT;
        if (ms > 0.8 && ms < 45) { t.v = v0; t.maxEx = Math.min(60, dt * 1.2); }
      }
      if (old.shownP) {
        const m = railModel(t, now);
        const c = [old.shownP[0] - m.p[0], old.shownP[1] - m.p[1]];
        const em = Math.hypot(c[0] * KX, c[1]) * M_LAT;
        // écart rattrapé en douceur, d'autant plus lentement qu'il est grand (au plus 15 s)
        if (em < 3000) { t.corr = c; t.corrDur = Math.max(CORR_S, Math.min(15, em / 40)); }
      }
    }
    rail.set(id, t);
  }
  for (const id of [...rail.keys()]) if (id.startsWith(ag + ':') && !seen.has(id)) rail.delete(id);
}

const railKey = (t) => t.ag + ':' + t.routeId;
function railVisible(t) {
  if (railActive.has(railKey(t))) return true;
  // branche inconnue des données statiques : visible dès qu'une branche de la compagnie est allumée
  return !(R.routes[t.ag] || {})[t.routeId] && [...railActive].some((k) => k.startsWith(t.ag + ':'));
}

async function refreshAlerts() {
  try { alerts = await GTFSRT.alerts(); if (focus) renderLinePanel(true); }
  catch (e) { console.warn('alertes', e); }
}

// ---------- carte
const map = new maplibregl.Map({ container: 'map', style: STYLE, ...MANHATTAN, maxPitch: 85, maxZoom: 23, attributionControl: { compact: true }, hash: true, antialias: true });
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
let baseLayers = [];

function addLayers() {
  baseLayers = map.getStyle().layers.map((l) => ({ id: l.id, type: l.type }));
  const vec = Object.entries(map.getStyle().sources).find(([, s]) => s.type === 'vector');
  if (vec) {
    map.addLayer({
      id: 'buildings-3d', type: 'fill-extrusion', source: vec[0], 'source-layer': 'building', minzoom: 12, layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 10], 0, '#1b1d22', 120, '#262931', 300, '#33363f'],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.88,
      },
    });
  }

  // trains régionaux, sous le métro
  map.addSource('rail-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: R.lines.map((l) => ({ type: 'Feature', properties: { a: l.a, k: l.a + ':' + l.r, c: l.c }, geometry: { type: 'LineString', coordinates: l.p } })) } });
  map.addLayer({ id: 'rail-lines-casing', type: 'line', source: 'rail-lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.4, 14, 6], 'line-opacity': 0.7 } });
  map.addLayer({ id: 'rail-lines', type: 'line', source: 'rail-lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 14, 2.6], 'line-opacity': 0.55, 'line-dasharray': [3, 1.5] } });
  const railSt = [];
  for (const [a, list] of Object.entries(R.stations)) for (const [id, [name, lon, lat]] of Object.entries(list)) railSt.push({ type: 'Feature', properties: { a, id, name }, geometry: { type: 'Point', coordinates: [lon, lat] } });
  map.addSource('rail-stations', { type: 'geojson', data: { type: 'FeatureCollection', features: railSt } });
  map.addLayer({ id: 'rail-stations', type: 'circle', source: 'rail-stations', minzoom: 10.5, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10.5, 1.8, 15, 4], 'circle-color': '#111214', 'circle-stroke-color': '#d0d3d8', 'circle-stroke-width': 1.2 } });

  // métro
  map.addSource('lines', { type: 'geojson', data: { type: 'FeatureCollection', features: S.shapes.map((s) => ({ type: 'Feature', properties: { c: routeColor(s.route), g: group(s.route) }, geometry: { type: 'LineString', coordinates: s.p } })) } });
  map.addLayer({ id: 'lines-glow', type: 'line', source: 'lines', layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 22], 'line-opacity': 0.35, 'line-blur': 6 } });
  map.addLayer({ id: 'lines-casing', type: 'line', source: 'lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 7, 17, 13, 21, 60] } });
  map.addLayer({ id: 'lines', type: 'line', source: 'lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 3.6, 17, 8, 21, 48] } });

  map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: S.stations.map((s) => ({ type: 'Feature', properties: { id: s.id, name: s.name, gs: ',' + [...new Set(s.routes.map(group))].join(',') + ',' }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) } });
  map.addLayer({ id: 'stations', type: 'circle', source: 'stations', minzoom: 11, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.6, 15, 5], 'circle-color': '#fff', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.2 } });
  map.addLayer({ id: 'station-names', type: 'symbol', source: 'stations', minzoom: 13.5, layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11.5, 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-optional': true }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'rail-names', type: 'symbol', source: 'rail-stations', minzoom: 12.5, layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#c9ccd2', 'text-halo-color': '#000', 'text-halo-width': 1.5 } });

  // rames
  map.addSource('trains', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('trains3d', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'trains-3d', type: 'fill-extrusion', source: 'trains3d', layout: { visibility: 'none' }, paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-opacity': 0.95 } });
  makeTrainIcons();
  map.addLayer({ id: 'train-sel', type: 'circle', source: 'trains', filter: ['==', ['get', 'sel'], true], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 9, 14, 20, 17, 40], 'circle-color': 'rgba(255,255,255,0.12)', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'trains', type: 'symbol', source: 'trains', layout: {
    'icon-image': ['get', 'i'], 'icon-rotate': ['-', ['get', 'b'], 90], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
    'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['case', ['get', 'sel'], 2, ['==', ['get', 'k'], 'm'], 1, 0],
    'icon-size': ['interpolate', ['exponential', 1.7], ['zoom'], 10, 0.42, 13, 0.8, 15, 1.7, 17, 3.6],
  } });
  map.addLayer({ id: 'train-labels', type: 'symbol', source: 'trains', minzoom: 13, filter: ['==', ['get', 'k'], 'm'], layout: { 'text-field': ['get', 'l'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 15, 12, 17, 16], 'text-allow-overlap': true, 'text-ignore-placement': true, 'text-rotation-alignment': 'viewport', 'text-pitch-alignment': 'viewport' }, paint: { 'text-color': ['get', 't'], 'text-halo-color': ['get', 'c'], 'text-halo-width': 1 } });

  map.on('click', (e) => handleClick(e.point));
  for (const l of ['trains', 'trains-3d', 'stations', 'lines']) {
    map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('dragstart', () => { if (mode === 'cab') setMode('3d'); });
}

function handleClick(pt) {
  const box = [[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]];
  const hit = (layers) => map.queryRenderedFeatures(box, { layers: layers.filter((l) => map.getLayer(l)) });
  let f = hit(['trains', 'trains-3d']);
  if (f.length) { const p = f[0].properties; return p.k === 'r' ? openRail(p.id) : openTrain(p.id); }
  f = hit(['stations']);
  if (f.length) return openStation(f[0].properties.id);
  f = hit(['lines']);
  if (f.length) { const g = f[0].properties.g; return active.has(g) ? setFocus(g) : toggleLine(g); }
  hideCard();
}

// silhouettes de rames (vues de dessus, nez vers la droite), une par couleur
function makeTrainIcons() {
  const colors = new Set(Object.values(S.routes).map((r) => r.color));
  for (const ag of Object.keys(R.routes)) for (const r of Object.values(R.routes[ag])) colors.add(r.color);
  colors.add('#0039a6'); colors.add('#ee0034'); colors.add('#808183');
  for (const c of colors) {
    for (const rail of [false, true]) {
      const id = (rail ? 'rail-' : 'sub-') + c;
      if (map.hasImage(id)) continue;
      const W = rail ? 96 : 76, H = rail ? 22 : 26, r = rail ? 5 : 12, cars = rail ? 6 : 5;
      const cv = document.createElement('canvas'); cv.width = W + 6; cv.height = H + 6;
      const g = cv.getContext('2d');
      g.translate(3, 3);
      g.beginPath(); g.roundRect(0, 0, W, H, [r * 0.5, r, r, r * 0.5]);
      g.fillStyle = c; g.fill();
      g.lineWidth = 3; g.strokeStyle = rail ? '#ffffff' : '#000000'; g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 1.5;
      for (let i = 1; i < cars; i++) { const x = (W * i) / cars; g.beginPath(); g.moveTo(x, 3); g.lineTo(x, H - 3); g.stroke(); }
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(W - 5, H * 0.25, 3, H * 0.5); // feux avant
      const img = g.getImageData(0, 0, cv.width, cv.height);
      map.addImage(id, { width: cv.width, height: cv.height, data: img.data }, { pixelRatio: 2 });
    }
  }
}

// ---------- modes de vue
const savedPaint = new Map();
function dimBase(on) {
  for (const l of baseLayers) {
    if (l.type === 'background') continue;
    const props = l.type === 'fill' ? ['fill-opacity'] : l.type === 'line' ? ['line-opacity'] : l.type === 'symbol' ? ['text-opacity', 'icon-opacity'] : [];
    for (const p of props) {
      const key = l.id + '|' + p;
      if (!savedPaint.has(key)) savedPaint.set(key, map.getPaintProperty(l.id, p) ?? 1);
      map.setPaintProperty(l.id, p, on ? 0.12 : savedPaint.get(key));
    }
  }
}

function setMode(m) {
  if (m === 'cab' && !cabTrain) {
    cabTrain = pickCabTrain();
    if (!cabTrain) return toast(active.size ? 'Aucune rame en marche près du centre de la carte' : 'Allume d\'abord une ligne de métro');
  }
  mode = m;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  document.body.classList.toggle('cab', m === 'cab');
  document.getElementById('cab-hud').classList.toggle('closed', m !== 'cab');
  document.getElementById('hint').classList.toggle('closed', !(m === '3d' || m === 'under'));
  const three = m !== 'plan';
  if (map.getLayer('buildings-3d')) {
    map.setLayoutProperty('buildings-3d', 'visibility', three ? 'visible' : 'none');
    map.setPaintProperty('buildings-3d', 'fill-extrusion-opacity', m === 'under' ? 0.16 : 0.88);
  }
  map.setLayoutProperty('trains-3d', 'visibility', three ? 'visible' : 'none');
  map.setLayoutProperty('lines-glow', 'visibility', m === 'under' || focus ? 'visible' : 'none');
  const fade = three ? ['interpolate', ['linear'], ['zoom'], 15.3, 1, 16.3, 0] : 1;
  map.setPaintProperty('trains', 'icon-opacity', fade);
  map.setPaintProperty('train-labels', 'text-opacity', fade);
  map.setLayoutProperty('train-labels', 'visibility', m === 'cab' ? 'none' : 'visible');
  map.setLayoutProperty('train-sel', 'visibility', m === 'cab' ? 'none' : 'visible');
  dimBase(m === 'under');
  if (m === 'plan') { cabTrain = null; map.easeTo({ pitch: 0, duration: 1000 }); }
  else if (m === '3d' || m === 'under') { cabTrain = null; map.easeTo({ pitch: m === 'under' ? 55 : 62, zoom: Math.max(map.getZoom(), 13.5), duration: 1200 }); }
  else if (m === 'cab') { cabBearing = null; hideCard(); }
}

function pickCabTrain() {
  const c = map.getCenter();
  let best = null, bd = Infinity;
  for (const tr of trains.values()) {
    if (!tr.shown || !active.has(group(tr.r))) continue;
    const d = seglen(tr.shown, [c.lng, c.lat]);
    if (d < bd && tr.moving) { bd = d; best = tr.id; }
  }
  return best;
}

// ---------- popups
const fmtMin = (t, now) => { const m = Math.round((t - now) / 60); return m <= 0 ? 'à quai' : m + ' min'; };
const bulletHtml = (r, cls = '') => `<span class="bullet ${cls}${/X$/.test(r) ? ' diamond' : ''}" style="background:${routeColor(r)};color:${routeText(r)}"><span>${label(r)}</span></span>`;

function trainHtml(tr) {
  const now = nowS();
  const rows = tr.s.filter((x) => (x[1] || x[2]) >= now - 30 && stationById[x[0]]).slice(0, 6)
    .map((x) => `<tr><td>${esc(stationById[x[0]].name)}</td><td>${fmtMin(x[1] || x[2], now)}</td></tr>`).join('');
  const dir = tr.d === 'N' ? 'Uptown' : 'Downtown';
  return `<div class="pop"><h3>${bulletHtml(tr.r)} ${esc(destination(tr))}</h3>
    <div class="meta">${dir}${tr.n ? ' · rame ' + esc(tr.n.trim()) : ''}</div>
    <table>${rows || '<tr><td class="muted">Pas de prévision</td><td></td></tr>'}</table>
    <div class="actions"><button onclick="enterCab('${esc(tr.id)}')">Vue cabine</button><button onclick="selectLine('${group(tr.r)}')">Ligne ${label(tr.r)}</button></div></div>`;
}

function showCard(html, kind) {
  const c = document.getElementById('card');
  c.innerHTML = `<button class="close" onclick="hideCard()" aria-label="Fermer">×</button>${html}`;
  c.classList.remove('closed');
  cardKind = kind;
}
function hideCard() {
  document.getElementById('card').classList.add('closed');
  popupTrain = null; cardKind = null;
}
window.hideCard = hideCard;

function openTrain(id) {
  const tr = trains.get(id);
  if (!tr || !tr.shown) return;
  popupTrain = id;
  showCard(trainHtml(tr), 'train');
}

function railRoute(t) { return ((R.routes[t.ag] || {})[t.routeId]) || { name: t.ag === 'LIRR' ? 'Long Island Rail Road' : 'Metro-North', color: t.ag === 'LIRR' ? '#0039a6' : '#ee0034' }; }
function railStation(ag, id) { const s = (R.stations[ag] || {})[id]; return s ? s[0] : id || ''; }

function railHtml(t) {
  const r = railRoute(t);
  const now = nowS();
  const delay = t.delay == null ? '' : Math.abs(t.delay) < 90 ? 'à l\'heure' : (t.delay > 0 ? `retard ${Math.round(t.delay / 60)} min` : `avance ${Math.round(-t.delay / 60)} min`);
  return `<div class="pop"><h3><span class="rail-chip ${t.ag.toLowerCase()}">${t.ag}</span> ${esc(t.dest ? railStation(t.ag, t.dest) : r.name)}</h3>
    <div class="meta" style="color:${r.color}">${esc(r.name)}${t.num ? ' · train ' + esc(t.num) : ''}</div>
    <table>${t.next ? `<tr><td>Prochain arrêt : ${esc(railStation(t.ag, t.next))}</td><td>${t.nextT ? fmtMin(t.nextT, now) : ''}</td></tr>` : ''}
    <tr><td>${delay || 'Position GPS'}</td><td>GPS</td></tr></table></div>`;
}

function openRail(id) {
  const t = rail.get(id);
  if (!t) return;
  popupTrain = id;
  showCard(railHtml(t), 'rail');
}

function openStation(id) {
  popupTrain = null;
  const s = stationById[id];
  const now = nowS();
  const arrivals = [];
  for (const tr of trains.values()) for (const x of tr.s) if (x[0] === id && (x[1] || x[2]) >= now - 20) arrivals.push([x[1] || x[2], tr]);
  arrivals.sort((a, b) => a[0] - b[0]);
  const rows = arrivals.slice(0, 8).map(([t, tr]) => `<tr><td>${bulletHtml(tr.r, 'sm')} ${esc(destination(tr))}</td><td>${fmtMin(t, now)}</td></tr>`).join('');
  const al = alerts.filter((a) => a.stops.some((x) => x.replace(/[NS]$/, '') === id)).slice(0, 2).map((a) => `<div class="meta">⚠ ${esc(a.header)}</div>`).join('');
  showCard(`<div class="pop"><h3>${esc(s.name)}</h3><div style="display:flex;gap:4px;margin-bottom:8px">${s.routes.map((r) => bulletHtml(r, 'sm')).join('')}</div>${al}<table>${rows || '<tr><td>Aucun passage annoncé</td><td></td></tr>'}</table></div>`, 'station');
}

window.enterCab = (id) => { cabTrain = id; setMode('cab'); };

// ---------- panneau de ligne : trajet complet et trafic
function linePattern(g) {
  // le plus long gabarit vers le sud (ordre nord -> sud), sinon le plus long vers le nord, inversé
  let best = null;
  for (const [k, list] of Object.entries(S.patterns)) {
    const rd = routeDirOf(k);
    if (!rd) continue;
    const [r, d] = rd.split('|');
    if (g === 'S' ? r !== 'GS' : r !== g) continue;
    const l = d === 'S' ? list : list.slice().reverse();
    if (!best || l.length > best.length) best = l;
  }
  return best || [];
}

function lineStatus(g) {
  const routes = Object.keys(S.routes).filter((r) => group(r) === g);
  return alerts.filter((a) => a.routes.some((r) => routes.includes(r))).sort((a, b) => b.rank - a.rank);
}

function statusColor(rank) {
  if (!rank) return 'var(--good)';
  if ([27, 28, 29, 30, 34, 35].includes(rank)) return 'var(--bad)';
  if (rank >= 24) return 'var(--warn)';
  return '#4a90e2';
}

// ---------- sélection des lignes : rien n'est allumé au départ, chaque ligne allumée passe en direct
const GREY = '#3a3d44';
function applyLineStyle() {
  const act = ['literal', [...active]];
  const on = ['in', ['get', 'g'], act];
  map.setPaintProperty('lines', 'line-color', ['case', on, ['get', 'c'], GREY]);
  map.setPaintProperty('lines', 'line-width', ['interpolate', ['linear'], ['zoom'],
    10, ['case', on, 2.6, 0.8], 14, ['case', on, 5, 1.6], 17, ['case', on, 10, 3], 21, ['case', on, 48, 10]]);
  map.setPaintProperty('lines-casing', 'line-opacity', ['case', on, 1, 0]);
  map.setPaintProperty('lines-casing', 'line-width', ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 9, 17, 16, 21, 60]);
  map.setLayoutProperty('lines', 'line-sort-key', ['case', on, 1, 0]);
  map.setPaintProperty('lines-glow', 'line-opacity', focus ? ['case', ['==', ['get', 'g'], focus], 0.5, 0] : 0);
  map.setLayoutProperty('lines-glow', 'visibility', mode === 'under' || focus ? 'visible' : 'none');
  const stf = active.size ? ['any', ...[...active].map((g) => ['in', ',' + g + ',', ['get', 'gs']])] : ['in', ',-,', ['get', 'gs']];
  map.setFilter('stations', stf); map.setFilter('station-names', stf);
  // régional : branches allumées en couleur, les autres en gris
  const ron = ['in', ['get', 'k'], ['literal', [...railActive]]];
  map.setPaintProperty('rail-lines', 'line-color', ['case', ron, ['get', 'c'], GREY]);
  map.setPaintProperty('rail-lines', 'line-opacity', ['case', ron, 0.95, 0.6]);
  map.setPaintProperty('rail-lines', 'line-width', ['interpolate', ['linear'], ['zoom'], 9, ['case', ron, 1.6, 0.7], 14, ['case', ron, 3.6, 1.4]]);
  map.setPaintProperty('rail-lines-casing', 'line-opacity', ['case', ron, 0.8, 0]);
  const ags = [...new Set([...railActive].map((k) => k.split(':')[0]))];
  const rsf = ['in', ['get', 'a'], ['literal', ags]];
  map.setFilter('rail-stations', rsf); map.setFilter('rail-names', rsf);
}

function linesChanged() {
  applyLineStyle();
  renderLegendState();
  syncUrl();
  schedulePoll(100);
}

function toggleLine(g) {
  if (active.has(g)) {
    active.delete(g);
    if (focus === g) setFocus([...active].pop() || null, false);
  } else {
    active.add(g);
    setFocus(g, true);
  }
  linesChanged();
}

function setLines(list) {
  active.clear();
  for (const g of list) active.add(g);
  if (!active.has(focus)) setFocus(null);
  linesChanged();
}

function toggleBranch(k) {
  railActive.has(k) ? railActive.delete(k) : railActive.add(k);
  linesChanged();
}

function toggleAgency(ag) {
  const keys = Object.keys(R.routes[ag]).map((r) => ag + ':' + r);
  const any = keys.some((k) => railActive.has(k));
  for (const k of keys) any ? railActive.delete(k) : railActive.add(k);
  linesChanged();
}

// ligne détaillée dans le panneau (trajet complet + trafic) ; fit = recadrer la carte dessus
function setFocus(g, fit = false) {
  focus = g;
  applyLineStyle();
  renderLegendState();
  document.getElementById('line-panel').classList.toggle('closed', !focus);
  if (!focus) return;
  hideCard();
  const pat = linePattern(focus);
  if (fit && pat.length && mode !== 'cab') {
    const b = new maplibregl.LngLatBounds();
    for (const id of pat) { const s = stationById[id]; if (s) b.extend([s.lon, s.lat]); }
    const wide = window.innerWidth > 700;
    map.fitBounds(b, { padding: wide ? { top: 40, bottom: 40, left: 340, right: 420 } : { top: 40, bottom: window.innerHeight * 0.55, left: 30, right: 30 }, bearing: map.getBearing(), pitch: map.getPitch(), duration: 1200, maxZoom: 14 });
  }
  stripPat = null;
  renderLinePanel(false);
}
window.selectLine = (g) => (active.has(g) ? setFocus(g, true) : toggleLine(g));

function syncUrl() {
  const q = new URLSearchParams(location.search);
  q.delete('line');
  active.size ? q.set('lines', [...active].join(',')) : q.delete('lines');
  railActive.size ? q.set('rail', [...railActive].join(',')) : q.delete('rail');
  const qs = q.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
  history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
}

let toastT = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('closed');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.add('closed'), 3200);
}

let stripPat = null;
function renderLinePanel(soft) {
  if (!focus) return;
  const r = focus === 'S' ? 'GS' : focus;
  const info = routeOf(r);
  const pat = linePattern(focus);
  const tabs = document.getElementById('lineTabs');
  tabs.innerHTML = active.size > 1 ? [...active].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y)).map((g) => {
    const rr = g === 'S' ? 'GS' : g;
    return `<button class="bullet sm${g === focus ? ' cur' : ''}" data-g="${g}" style="background:${routeColor(rr)};color:${routeText(rr)}" title="${esc(routeOf(rr).long || '')}"><span>${label(rr)}</span></button>`;
  }).join('') : '';
  tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => setFocus(b.dataset.g, true)));
  const head = document.getElementById('lineHead');
  head.innerHTML = `${bulletHtml(r, 'lg')}<div><div class="name">${esc(info.long || info.name)}</div><div class="sub">${pat.length} stations · ${esc((stationById[pat[0]] || {}).name || '')} ↔ ${esc((stationById[pat[pat.length - 1]] || {}).name || '')}</div></div>`;
  const al = lineStatus(focus);
  const top = al[0];
  document.getElementById('lineStatus').innerHTML = `<span class="dot" style="background:${statusColor(top && top.rank)}"></span>${top ? esc(top.status || 'Alerte') : 'Good Service'}<span style="margin-left:auto;font-weight:400;color:var(--muted);font-size:11px">${al.length ? al.length + ' alerte' + (al.length > 1 ? 's' : '') : ''}</span>`;
  document.getElementById('lineAlerts').innerHTML = al.slice(0, 6).map((a) => `<details><summary><b>${esc(a.status)}</b>${esc(a.header)}</summary>${a.description ? `<p>${esc(a.description)}</p>` : ''}</details>`).join('');
  if (soft && stripPat) return;
  stripPat = pat;
  const strip = document.getElementById('strip');
  const H = 24;
  let html = `<div class="strip-inner" style="height:${pat.length * H + 8}px"><div class="st-line" style="top:${H / 2}px;height:${Math.max(0, (pat.length - 1) * H)}px;background:${info.color}"></div>`;
  pat.forEach((id, i) => {
    const s = stationById[id] || { name: id, routes: [] };
    html += `<div class="st-row" style="top:${i * H}px" data-id="${id}"><div class="st-dot" style="top:${(H - 10) / 2}px"></div><div class="st-name${s.routes.length > 3 ? ' major' : ''}">${esc(s.name)}</div></div>`;
  });
  html += '<div id="marks"></div></div>';
  strip.innerHTML = html;
  strip.querySelectorAll('.st-row').forEach((el) => (el.onclick = () => { const s = stationById[el.dataset.id]; if (s) { map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 15) }); openStation(el.dataset.id); } }));
  updateStrip();
}

function updateStrip() {
  if (!focus || !stripPat) return;
  const marks = document.getElementById('marks');
  if (!marks) return;
  const idx = new Map(stripPat.map((id, i) => [id, i]));
  const H = 24;
  let n = 0, s = 0, html = '';
  for (const tr of trains.values()) {
    if (group(tr.r) !== focus || !tr.pos) continue;
    const p = tr.pos;
    const a = idx.get(p.from), b = idx.get(p.next);
    let y;
    if (a != null && b != null) y = a + (b - a) * (p.f || 0);
    else if (a != null) y = a; else if (b != null) y = b; else continue;
    const north = tr.d === 'N';
    north ? n++ : s++;
    html += `<div class="tr-mark ${north ? 'n' : 's'}" title="${esc(label(tr.r) + ' → ' + destination(tr))}" data-id="${esc(tr.id)}" style="top:${y * H + 6}px;${north ? 'border-bottom-color' : 'border-top-color'}:${routeColor(tr.r)}"></div>`;
  }
  marks.innerHTML = html;
  marks.querySelectorAll('.tr-mark').forEach((el) => (el.onclick = () => { const tr = trains.get(el.dataset.id); if (tr && tr.shown) { map.flyTo({ center: tr.shown, zoom: Math.max(map.getZoom(), 14.5) }); openTrain(tr.id); } }));
  document.getElementById('lineCounts').textContent = `${n} ▲ · ${s} ▼ en ligne`;
}

// ---------- légende et boutons
const shortBranch = (n) => n.replace(/ Branch$/, '').replace(/ Service$/, '');
function buildLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = '';
  for (const row of LEGEND_ROWS) {
    const grp = document.createElement('div');
    grp.className = 'lg-grp';
    for (const g of row) {
      const r = g === 'S' ? 'GS' : g;
      if (!S.routes[r]) continue;
      const b = document.createElement('button');
      b.className = 'bullet tog';
      b.dataset.g = g;
      b.style.setProperty('--c', routeColor(r));
      b.style.setProperty('--t', routeText(r));
      b.innerHTML = `<span>${label(r)}</span><span class="n"></span>`;
      b.title = (S.routes[r].long || '') + ' : allumer / éteindre';
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => toggleLine(g);
      grp.appendChild(b);
    }
    el.appendChild(grp);
  }
  document.getElementById('allSub').onclick = () => setLines(ORDER.filter((g) => S.routes[g === 'S' ? 'GS' : g]));
  document.getElementById('noneSub').onclick = () => setLines([]);

  const rl = document.getElementById('rail-legend');
  rl.innerHTML = '';
  for (const ag of ['LIRR', 'MNR']) {
    const box = document.createElement('div');
    box.className = 'rail-ag';
    const full = ag === 'LIRR' ? 'Long Island Rail Road' : 'Metro-North';
    box.innerHTML = `<button class="rail-master" data-a="${ag}"><span class="rail-chip ${ag.toLowerCase()}">${ag}</span><span>${full}</span><span class="state"></span></button><div class="branches"></div>`;
    const br = box.querySelector('.branches');
    const routes = Object.entries(R.routes[ag]).sort((x, y) => x[1].name.localeCompare(y[1].name));
    for (const [rid, info] of routes) {
      const b = document.createElement('button');
      b.className = 'branch';
      b.dataset.k = ag + ':' + rid;
      b.style.setProperty('--c', info.color);
      b.innerHTML = `<i></i>${esc(shortBranch(info.name))}<span class="cnt"></span>`;
      b.onclick = () => toggleBranch(b.dataset.k);
      br.appendChild(b);
    }
    box.querySelector('.rail-master').onclick = () => toggleAgency(ag);
    rl.appendChild(box);
  }

  document.querySelectorAll('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  document.getElementById('lineClose').onclick = () => setFocus(null);
  document.getElementById('collapse').onclick = () => document.getElementById('panel').classList.toggle('collapsed');
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (cardKind) hideCard(); else if (mode === 'cab') setMode('3d'); else if (focus) setFocus(null);
  });
  setupOrbit();
  document.getElementById('cabExit').onclick = () => setMode('3d');
  document.getElementById('cabNext').onclick = () => {
    const ids = [...trains.values()].filter((t) => t.moving && t.id !== cabTrain && active.has(group(t.r))).map((t) => t.id);
    if (ids.length) { cabTrain = ids[Math.floor(Math.random() * ids.length)]; cabBearing = null; }
  };
}

// état visuel des pastilles et des branches (allumée, en chargement, ligne détaillée)
function renderLegendState() {
  const loadingFeeds = new Set([...feedState].filter(([, st]) => st.loading && !st.ts).map(([f]) => f));
  document.querySelectorAll('#legend .bullet').forEach((b) => {
    const g = b.dataset.g, on = active.has(g);
    b.classList.toggle('on', on);
    b.classList.toggle('focus', g === focus);
    b.setAttribute('aria-pressed', on);
    b.classList.toggle('loading', on && [].concat(SUB_FEED[g] || []).some((f) => loadingFeeds.has('nyct%2F' + f)));
  });
  document.querySelectorAll('.branch').forEach((b) => {
    const on = railActive.has(b.dataset.k);
    b.classList.toggle('on', on);
    b.classList.toggle('loading', on && loadingFeeds.has(RAIL_FEEDS[b.dataset.k.split(':')[0]]));
  });
  document.querySelectorAll('.rail-master').forEach((b) => {
    const ag = b.dataset.a, keys = Object.keys(R.routes[ag]).map((r) => ag + ':' + r);
    const n = keys.filter((k) => railActive.has(k)).length;
    b.classList.toggle('on', n > 0);
    b.querySelector('.state').textContent = n === 0 ? 'tout allumer' : n === keys.length ? 'tout éteindre' : `${n}/${keys.length} · éteindre`;
  });
  document.getElementById('emptyHint').classList.toggle('hidden', active.size + railActive.size > 0);
}

// En 3D : glisser = tourner autour du centre et incliner ; Maj + glisser = se déplacer
function setupOrbit() {
  const box = map.getContainer();
  let o = null;
  box.addEventListener('mousedown', (e) => {
    if (!(mode === '3d' || mode === 'under') || e.button !== 0 || e.shiftKey || !map.getCanvasContainer().contains(e.target)) return;
    o = { x: e.clientX, y: e.clientY, b: map.getBearing(), p: map.getPitch(), moved: false };
    e.stopPropagation(); e.preventDefault();
    map.getCanvas().style.cursor = 'grabbing';
  }, true);
  window.addEventListener('mousemove', (e) => {
    if (!o) return;
    const dx = e.clientX - o.x, dy = e.clientY - o.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) o.moved = true;
    map.jumpTo({ bearing: o.b - dx * 0.35, pitch: Math.max(0, Math.min(85, o.p - dy * 0.3)) });
  });
  window.addEventListener('mouseup', (e) => {
    if (!o) return;
    const moved = o.moved; o = null;
    map.getCanvas().style.cursor = '';
    if (!moved) { const r = map.getCanvas().getBoundingClientRect(); handleClick({ x: e.clientX - r.left, y: e.clientY - r.top }); }
  });
}

// ---------- boucle d'animation
let lastFrame = 0, lastHud = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!map.getSource('trains') || ts - lastFrame < 15) return;
  lastFrame = ts;
  const now = nowS();
  const feats = [], boxes = [];
  const perGroup = {};
  const three = mode !== 'plan';
  // écart entre les deux sens : 30 m en vue d'ensemble, quelques mètres de près (rames sur la voie)
  const sideM = Math.max(2.2, Math.min(30, 30 * Math.pow(2, 14 - map.getZoom())));
  for (const tr of trains.values()) {
    const g = group(tr.r);
    const pos = position(tr, effTime(tr, now));
    tr.pos = pos;
    if (!pos) { tr.shown = null; continue; }
    if (pos.dir) tr.head = pos.dir;
    tr.moving = !!pos.dir && !pos.still;
    const p = tr.head ? offsetRight(pos.p, tr.head, sideM) : pos.p;
    tr.shown = p;
    if (!active.has(g)) continue;
    perGroup[g] = (perGroup[g] || 0) + 1;
    const c = routeColor(tr.r);
    if (mode === 'cab' && tr.id === cabTrain) continue;
    feats.push({ type: 'Feature', properties: { k: 'm', id: tr.id, c, t: routeText(tr.r), l: label(tr.r), g, i: 'sub-' + c, b: tr.head ? bearingOf(tr.head) : 0, sel: tr.id === popupTrain }, geometry: { type: 'Point', coordinates: p } });
    if (three && tr.head && !(mode === 'cab' && tr.id === cabTrain)) { const [n, len] = CARS[tr.r] || [10, 18.3]; pushCars(boxes, p, tr.head, n, len, c, tr.id, 'm'); }
  }
  const perBranch = {};
  for (const t of rail.values()) {
    const q = railPos(t, now);
    const p = q.p;
    t.shownP = p;
    if (q.dir) t.dir = q.dir;
    if (!railVisible(t)) continue;
    perBranch[railKey(t)] = (perBranch[railKey(t)] || 0) + 1;
    const c = railRoute(t).color;
    const dir = t.dir || (t.bearing != null ? [Math.sin(t.bearing * Math.PI / 180) / KX, Math.cos(t.bearing * Math.PI / 180)] : null);
    feats.push({ type: 'Feature', properties: { k: 'r', id: t.id, c, i: 'rail-' + c, b: dir ? bearingOf(dir) : 0, sel: t.id === popupTrain }, geometry: { type: 'Point', coordinates: p } });
    if (three && dir) { const [n, len] = RAIL_CARS[t.ag]; pushCars(boxes, p, dir, n, len, c, t.id, 'r'); }
  }
  map.getSource('trains').setData({ type: 'FeatureCollection', features: feats });
  if (three) map.getSource('trains3d').setData({ type: 'FeatureCollection', features: boxes });
  if (mode === 'cab') cabCamera();
  if (ts - lastHud > 1000) { lastHud = ts; updateHud(now, perGroup, perBranch); }
}

function cabCamera() {
  const tr = trains.get(cabTrain);
  if (!tr || !tr.shown) { cabTrain = pickCabTrain(); if (!cabTrain) setMode('3d'); return; }
  if (!tr.head) return;
  const target = bearingOf(tr.head);
  if (cabBearing == null) cabBearing = target;
  cabBearing += (((target - cabBearing + 540) % 360) - 180) * 0.06;
  const rad = cabBearing * Math.PI / 180, ux = Math.sin(rad), uy = Math.cos(rad);
  const [n, len] = CARS[tr.r] || [10, 18.3];
  const half = (n * len + (n - 1) * 1.2) / 2;
  // œil du conducteur : à l'avant de la rame, à 3,5 m de haut ; regard vers la voie, 40 m devant
  const base = tr.pos ? offsetRight(tr.pos.p, tr.head, 2.2) : tr.shown;
  const eye = [base[0] + (ux * (half - 2)) / M_LON, base[1] + (uy * (half - 2)) / M_LAT];
  const look = [eye[0] + (ux * 40) / M_LON, eye[1] + (uy * 40) / M_LAT];
  const cam = map.calculateCameraOptionsFromTo(maplibregl.LngLat.convert(eye), 3.5, maplibregl.LngLat.convert(look), 0);
  map.jumpTo({ ...cam, pitch: Math.min(85, cam.pitch) });
}

function updateHud(now, perGroup, perBranch) {
  const d = new Date(now * 1000);
  document.getElementById('clock').textContent = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  document.getElementById('count').textContent = Object.values(perGroup).reduce((a, b) => a + b, 0);
  document.getElementById('countRail').textContent = Object.values(perBranch).reduce((a, b) => a + b, 0);
  document.querySelectorAll('#legend .bullet').forEach((b) => { b.querySelector('.n').textContent = active.has(b.dataset.g) ? (perGroup[b.dataset.g] ?? 0) : ''; });
  document.querySelectorAll('.branch').forEach((b) => { b.querySelector('.cnt').textContent = railActive.has(b.dataset.k) ? (perBranch[b.dataset.k] ?? 0) : ''; });
  // état du direct : âge des données MTA (horodatage du flux), flux en erreur
  const st = document.getElementById('status');
  const feeds = [...feedState.entries()];
  const bad = feeds.filter(([, f]) => f.err).map(([n]) => n.split('%2F')[1]);
  const ok = feeds.filter(([, f]) => f.ts);
  if (!feeds.length) { st.className = 'idle'; st.innerHTML = 'Direct en pause : allume une ligne'; }
  else if (!ok.length) { st.className = bad.length ? 'err' : ''; st.textContent = bad.length ? `Flux MTA injoignable (${bad.join(', ')})` : 'Connexion au direct MTA…'; }
  else {
    const age = Math.max(0, Math.round(now - Math.min(...ok.map(([, f]) => f.ts))));
    st.className = bad.length ? 'err' : age > 90 ? 'stale' : 'live';
    st.innerHTML = `<i class="dot"></i>${bad.length ? `${bad.length} flux en erreur (${esc(bad.join(', '))}) · ` : 'Direct MTA · '}données d'il y a ${age} s · ${ok.length} flux`;
  }
  if (popupTrain && cardKind) {
    const tr = trains.get(popupTrain);
    if (tr && cardKind === 'train') showCard(trainHtml(tr), 'train');
    else { const t = rail.get(popupTrain); if (t && cardKind === 'rail') showCard(railHtml(t), 'rail'); }
  }
  updateStrip();
  if (mode === 'cab') {
    const tr = trains.get(cabTrain);
    if (tr) {
      const nx = tr.s.find((x) => (x[1] || x[2]) >= now - 10 && stationById[x[0]]);
      document.getElementById('cabInfo').innerHTML = `${bulletHtml(tr.r, 'lg')}<div><div class="dest">${esc(destination(tr))}</div><div class="next">${nx ? `Prochain arrêt : <b style="color:#fff">${esc(stationById[nx[0]].name)}</b> · ${fmtMin(nx[1] || nx[2], now)}` : ''}</div></div>`;
    }
  }
}

// ---------- démarrage
(async function start() {
  await Promise.all([loadStatic(), new Promise((r) => map.once('load', r))]);
  prepRailGeo();
  addLayers();
  buildLegend();
  // lignes allumées via l'URL (?lines=A,C&rail=LIRR:1,MNR), sinon tout est éteint
  const q = new URLSearchParams(location.search);
  for (const g of (q.get('lines') || q.get('line') || '').split(',')) if (g && SUB_FEED[g]) active.add(g);
  for (const k of (q.get('rail') || '').split(',')) {
    const [ag, r] = k.split(':');
    if (!R.routes[ag]) continue;
    for (const rid of r ? [r] : Object.keys(R.routes[ag])) if (R.routes[ag][rid]) railActive.add(ag + ':' + rid);
  }
  linesChanged();
  if (active.size === 1) setFocus([...active][0], true);
  refreshAlerts();
  setInterval(refreshAlerts, ALERTS_MS);
  requestAnimationFrame(frame);
  if (q.get('mode')) setTimeout(() => setMode(q.get('mode')), 2500);
})();
