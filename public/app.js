/* NY TUBE : métro de New York, LIRR et Metro-North en temps réel.
 * Métro : la MTA publie les heures d'arrivée prévues (pas de GPS). Pour chaque rame on reconstruit
 * une frise horaire (station précédente -> arrêts suivants) et on interpole la position le long du
 * tracé réel, image par image.
 * LIRR / Metro-North : positions GPS du flux, lissées entre deux relevés. */
'use strict';

const REFRESH_MS = 15000;
const ALERTS_MS = 60000;
const MANHATTAN = { center: [-73.975, 40.758], zoom: 12.1, bearing: -29 };
const STYLE = 'https://tiles.openfreemap.org/styles/dark';
const FONT = ['Noto Sans Bold'];

const GROUP = { '6X': '6', '7X': '7', FX: 'F', GS: 'S', FS: 'S', H: 'S', SS: 'SI' };
const LABEL = { GS: 'S', FS: 'S', H: 'S', SI: 'SIR', SS: 'SIR' };
const ORDER = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'S', 'SI'];
const RAIL_FEEDS = { LIRR: 'lirr%2Fgtfs-lirr', MNR: 'mnr%2Fgtfs-mnr' };

let S = null, R = null;      // données statiques métro / trains régionaux
let stationById = {};
let pred = {};
let trains = new Map();      // métro
let rail = new Map();        // LIRR / MNR
let alerts = [];
let clockOffset = 0;
let selLine = null;          // groupe de ligne affiché dans le panneau
let railOn = { LIRR: true, MNR: true };
let mode = 'plan';
let popup = null, popupTrain = null;
let cabTrain = null, cabBearing = null;
let lastData = 0, statusErr = '';

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
  const at = (i) => { const A = stationById[tl[i].id]; return { p: [A.lon, A.lat], at: tl[i].id, from: tl[i].id, next: tl[i + 1] ? tl[i + 1].id : null, f: 0 }; };
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

let source = new URLSearchParams(location.search).get('src') || 'direct';
async function getSnapshot() {
  if (source === 'direct') {
    const snap = await GTFSRT.snapshot();
    if (snap.trains.length || snap.errors.length < GTFSRT.FEEDS.length) return snap;
    console.warn('MTA injoignable en direct, bascule sur le relais', snap.errors);
    source = 'api';
  }
  const res = await fetch('api/trains', { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

async function refresh() {
  try {
    const data = await getSnapshot();
    clockOffset = data.now - Date.now() / 1000;
    const now = nowS();
    const seen = new Set();
    for (const t of data.trains) {
      seen.add(t.id);
      const old = trains.get(t.id);
      trains.set(t.id, { ...t, tl: buildTimeline(t, now), shown: old && old.shown, head: old && old.head, blendFrom: old && old.shown, blendAt: now });
    }
    for (const id of trains.keys()) if (!seen.has(id)) trains.delete(id);
    lastData = data.feedTs || data.now;
    statusErr = data.errors.length ? `${data.errors.length} flux métro en erreur` : '';
  } catch (e) {
    statusErr = 'Flux MTA injoignable (' + e.message + ')';
  }
}

async function refreshRail() {
  for (const [ag, path] of Object.entries(RAIL_FEEDS)) {
    try {
      const feed = await GTFSRT.fetchFeed(path);
      const now = nowS();
      const tus = new Map();
      for (const tu of feed.trips) if (tu.trip) { tus.set(tu.trip.trip_id, tu); if (tu.eid) tus.set('e' + tu.eid, tu); }
      const seen = new Set();
      for (const v of feed.vehicles) {
        if (!v.position || !v.position.lat) continue;
        const id = ag + ':' + (v.eid || (v.trip && v.trip.trip_id));
        seen.add(id);
        const tu = (v.trip && tus.get(v.trip.trip_id)) || tus.get('e' + v.eid) || null;
        const routeId = (v.trip && v.trip.route_id) || (tu && tu.trip.route_id) || '';
        const stops = tu ? tu.stops : [];
        const lastStop = stops.length ? stops[stops.length - 1].stop_id : null;
        const nextStop = stops.find((u) => (u.arrival || u.departure || 0) >= now - 30);
        const delay = nextStop ? (nextStop.arr_delay ?? nextStop.dep_delay ?? null) : (tu ? tu.delay ?? null : null);
        const num = ag === 'MNR' ? (v.eid || (v.vehicle && v.vehicle.label)) : ((v.trip && v.trip.trip_id) || '').split('_').pop();
        const cur = [v.position.lon, v.position.lat];
        const old = rail.get(id);
        const moved = old && (old.cur[0] !== cur[0] || old.cur[1] !== cur[1]);
        rail.set(id, {
          id, ag, routeId, num, delay, dest: lastStop, next: nextStop ? nextStop.stop_id : null,
          nextT: nextStop ? (nextStop.arrival || nextStop.departure) : null,
          prev: old ? (moved ? old.shownP || old.cur : old.prev) : cur, cur,
          t0: moved || !old ? now : old.t0,
          dir: moved ? [cur[0] - old.cur[0], cur[1] - old.cur[1]] : (old ? old.dir : null),
          bearing: v.position.bearing, shownP: old ? old.shownP : cur,
        });
      }
      for (const id of [...rail.keys()]) if (id.startsWith(ag + ':') && !seen.has(id)) rail.delete(id);
    } catch (e) {
      console.warn('rail', ag, e);
    }
  }
}

async function refreshAlerts() {
  try { alerts = await GTFSRT.alerts(); if (selLine) renderLinePanel(true); }
  catch (e) { console.warn('alertes', e); }
}

// ---------- carte
const map = new maplibregl.Map({ container: 'map', style: STYLE, ...MANHATTAN, maxPitch: 85, attributionControl: { compact: true }, hash: true, antialias: true });
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
  map.addSource('rail-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: R.lines.map((l) => ({ type: 'Feature', properties: { a: l.a, c: l.c }, geometry: { type: 'LineString', coordinates: l.p } })) } });
  map.addLayer({ id: 'rail-lines-casing', type: 'line', source: 'rail-lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.4, 14, 6], 'line-opacity': 0.7 } });
  map.addLayer({ id: 'rail-lines', type: 'line', source: 'rail-lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 14, 2.6], 'line-opacity': 0.55, 'line-dasharray': [3, 1.5] } });
  const railSt = [];
  for (const [a, list] of Object.entries(R.stations)) for (const [id, [name, lon, lat]] of Object.entries(list)) railSt.push({ type: 'Feature', properties: { a, id, name }, geometry: { type: 'Point', coordinates: [lon, lat] } });
  map.addSource('rail-stations', { type: 'geojson', data: { type: 'FeatureCollection', features: railSt } });
  map.addLayer({ id: 'rail-stations', type: 'circle', source: 'rail-stations', minzoom: 10.5, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10.5, 1.8, 15, 4], 'circle-color': '#111214', 'circle-stroke-color': '#d0d3d8', 'circle-stroke-width': 1.2 } });

  // métro
  map.addSource('lines', { type: 'geojson', data: { type: 'FeatureCollection', features: S.shapes.map((s) => ({ type: 'Feature', properties: { c: routeColor(s.route), g: group(s.route) }, geometry: { type: 'LineString', coordinates: s.p } })) } });
  map.addLayer({ id: 'lines-glow', type: 'line', source: 'lines', layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 22], 'line-opacity': 0.35, 'line-blur': 6 } });
  map.addLayer({ id: 'lines-casing', type: 'line', source: 'lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 7, 17, 13] } });
  map.addLayer({ id: 'lines', type: 'line', source: 'lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 3.6, 17, 8] } });

  map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: S.stations.map((s) => ({ type: 'Feature', properties: { id: s.id, name: s.name }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) } });
  map.addLayer({ id: 'stations', type: 'circle', source: 'stations', minzoom: 11, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.6, 15, 5], 'circle-color': '#fff', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.2 } });
  map.addLayer({ id: 'station-names', type: 'symbol', source: 'stations', minzoom: 13.5, layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11.5, 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-optional': true }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'rail-names', type: 'symbol', source: 'rail-stations', minzoom: 12.5, layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#c9ccd2', 'text-halo-color': '#000', 'text-halo-width': 1.5 } });

  // rames
  map.addSource('trains', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('trains3d', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'trains-3d', type: 'fill-extrusion', source: 'trains3d', layout: { visibility: 'none' }, paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-opacity': 0.95 } });
  map.addLayer({ id: 'train-glow', type: 'circle', source: 'trains', filter: ['==', ['get', 'k'], 'm'], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 14, 17, 24], 'circle-color': ['get', 'c'], 'circle-opacity': 0.28, 'circle-blur': 0.8, 'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'trains', type: 'circle', source: 'trains', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['==', ['get', 'k'], 'r'], 3.2, 2.8], 13, ['case', ['==', ['get', 'k'], 'r'], 6, 6.5], 15, 9.5, 17, 13],
    'circle-color': ['get', 'c'],
    'circle-stroke-color': ['case', ['get', 'sel'], '#fff', ['==', ['get', 'k'], 'r'], '#fff', '#000'],
    'circle-stroke-width': ['case', ['get', 'sel'], 3, ['==', ['get', 'k'], 'r'], 1.6, 1.3],
    'circle-pitch-alignment': 'map',
  } });
  map.addLayer({ id: 'train-labels', type: 'symbol', source: 'trains', minzoom: 12.3, filter: ['==', ['get', 'k'], 'm'], layout: { 'text-field': ['get', 'l'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 12.3, 8, 15, 12, 17, 15], 'text-allow-overlap': true, 'text-ignore-placement': true, 'text-pitch-alignment': 'map', 'text-rotation-alignment': 'map' }, paint: { 'text-color': ['get', 't'] } });

  map.on('click', 'trains', (e) => { const p = e.features[0].properties; p.k === 'r' ? openRail(p.id) : openTrain(p.id); });
  map.on('click', 'trains-3d', (e) => { const p = e.features[0].properties; p.k === 'r' ? openRail(p.id) : openTrain(p.id); });
  map.on('click', 'stations', (e) => { if (!map.queryRenderedFeatures(e.point, { layers: ['trains'] }).length) openStation(e.features[0].properties.id); });
  map.on('click', 'lines', (e) => { if (!map.queryRenderedFeatures(e.point, { layers: ['trains', 'stations'] }).length) selectLine(e.features[0].properties.g); });
  for (const l of ['trains', 'trains-3d', 'stations', 'lines']) {
    map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('dragstart', () => { if (mode === 'cab') setMode('3d'); });
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
    if (!cabTrain) return;
  }
  mode = m;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  document.body.classList.toggle('cab', m === 'cab');
  document.getElementById('cab-hud').classList.toggle('hidden', m !== 'cab');
  const three = m !== 'plan';
  if (map.getLayer('buildings-3d')) {
    map.setLayoutProperty('buildings-3d', 'visibility', three ? 'visible' : 'none');
    map.setPaintProperty('buildings-3d', 'fill-extrusion-opacity', m === 'under' ? 0.16 : 0.88);
  }
  map.setLayoutProperty('trains-3d', 'visibility', three ? 'visible' : 'none');
  map.setLayoutProperty('lines-glow', 'visibility', m === 'under' ? 'visible' : 'none');
  map.setPaintProperty('trains', 'circle-opacity', three ? ['interpolate', ['linear'], ['zoom'], 13, 1, 14.5, 0] : 1);
  map.setPaintProperty('trains', 'circle-stroke-opacity', three ? ['interpolate', ['linear'], ['zoom'], 13, 1, 14.5, 0] : 1);
  map.setPaintProperty('train-glow', 'circle-opacity', three ? 0 : 0.28);
  map.setLayoutProperty('train-labels', 'visibility', three ? 'none' : 'visible');
  dimBase(m === 'under');
  if (m === 'plan') { cabTrain = null; map.easeTo({ pitch: 0, duration: 1000 }); }
  else if (m === '3d' || m === 'under') { cabTrain = null; map.easeTo({ pitch: m === 'under' ? 55 : 62, zoom: Math.max(map.getZoom(), 13.5), duration: 1200 }); }
  else if (m === 'cab') { cabBearing = null; if (popup) popup.remove(); }
}

function pickCabTrain() {
  const c = map.getCenter();
  let best = null, bd = Infinity;
  for (const tr of trains.values()) {
    if (!tr.shown || (selLine && group(tr.r) !== selLine)) continue;
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

function openTrain(id) {
  const tr = trains.get(id);
  if (!tr || !tr.shown) return;
  if (popup) popup.remove();
  popupTrain = id;
  popup = new maplibregl.Popup({ offset: 14, closeOnClick: true }).setLngLat(tr.shown).setHTML(trainHtml(tr)).addTo(map);
  popup.on('close', () => { if (popupTrain === id) popupTrain = null; });
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
  if (popup) popup.remove();
  popupTrain = id;
  popup = new maplibregl.Popup({ offset: 12 }).setLngLat(t.shownP).setHTML(railHtml(t)).addTo(map);
  popup.on('close', () => { if (popupTrain === id) popupTrain = null; });
}

function openStation(id) {
  if (popup) popup.remove();
  popupTrain = null;
  const s = stationById[id];
  const now = nowS();
  const arrivals = [];
  for (const tr of trains.values()) for (const x of tr.s) if (x[0] === id && (x[1] || x[2]) >= now - 20) arrivals.push([x[1] || x[2], tr]);
  arrivals.sort((a, b) => a[0] - b[0]);
  const rows = arrivals.slice(0, 8).map(([t, tr]) => `<tr><td>${bulletHtml(tr.r, 'sm')} ${esc(destination(tr))}</td><td>${fmtMin(t, now)}</td></tr>`).join('');
  const al = alerts.filter((a) => a.stops.some((x) => x.replace(/[NS]$/, '') === id)).slice(0, 2).map((a) => `<div class="meta">⚠ ${esc(a.header)}</div>`).join('');
  popup = new maplibregl.Popup({ offset: 8 }).setLngLat([s.lon, s.lat])
    .setHTML(`<div class="pop"><h3>${esc(s.name)}</h3><div style="display:flex;gap:4px;margin-bottom:8px">${s.routes.map((r) => bulletHtml(r, 'sm')).join('')}</div>${al}<table>${rows || '<tr><td>Aucun passage annoncé</td><td></td></tr>'}</table></div>`)
    .addTo(map);
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

function selectLine(g) {
  selLine = selLine === g ? null : g;
  document.querySelectorAll('#legend .bullet').forEach((b) => { b.classList.toggle('sel', b.dataset.g === selLine); b.classList.toggle('dim', !!selLine && b.dataset.g !== selLine); });
  const op = (on, off) => (selLine ? ['case', ['==', ['get', 'g'], selLine], on, off] : on);
  map.setPaintProperty('lines', 'line-opacity', op(1, 0.1));
  map.setPaintProperty('lines-casing', 'line-opacity', op(1, 0.1));
  map.setPaintProperty('lines-glow', 'line-opacity', op(0.4, 0));
  map.setPaintProperty('rail-lines', 'line-opacity', selLine ? 0.12 : 0.55);
  map.setPaintProperty('rail-lines-casing', 'line-opacity', selLine ? 0.2 : 0.7);
  if (popup) popup.remove();
  document.getElementById('line-panel').classList.toggle('hidden', !selLine);
  if (!selLine) return;
  const pat = linePattern(selLine);
  if (pat.length) {
    const b = new maplibregl.LngLatBounds();
    for (const id of pat) { const s = stationById[id]; if (s) b.extend([s.lon, s.lat]); }
    const wide = window.innerWidth > 700;
    map.fitBounds(b, { padding: wide ? { top: 40, bottom: 40, left: 340, right: 420 } : { top: 40, bottom: window.innerHeight * 0.55, left: 30, right: 30 }, bearing: map.getBearing(), pitch: map.getPitch(), duration: 1200, maxZoom: 14 });
  }
  stripPat = null;
  renderLinePanel(false);
}

let stripPat = null;
function renderLinePanel(soft) {
  if (!selLine) return;
  const r = selLine === 'S' ? 'GS' : selLine;
  const info = routeOf(r);
  const pat = linePattern(selLine);
  const head = document.getElementById('lineHead');
  head.innerHTML = `${bulletHtml(r, 'lg')}<div><div class="name">${esc(info.long || info.name)}</div><div class="sub">${pat.length} stations · ${esc((stationById[pat[0]] || {}).name || '')} ↔ ${esc((stationById[pat[pat.length - 1]] || {}).name || '')}</div></div>`;
  const al = lineStatus(selLine);
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
  if (!selLine || !stripPat) return;
  const marks = document.getElementById('marks');
  if (!marks) return;
  const idx = new Map(stripPat.map((id, i) => [id, i]));
  const H = 24;
  let n = 0, s = 0, html = '';
  for (const tr of trains.values()) {
    if (group(tr.r) !== selLine || !tr.pos) continue;
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
function buildLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = '';
  for (const g of ORDER) {
    const r = g === 'S' ? 'GS' : g;
    if (!S.routes[r]) continue;
    const b = document.createElement('button');
    b.className = 'bullet';
    b.dataset.g = g;
    b.style.background = routeColor(r);
    b.style.color = routeText(r);
    b.innerHTML = `<span>${label(r)}</span><span class="n"></span>`;
    b.title = S.routes[r].long || '';
    b.onclick = () => selectLine(g);
    el.appendChild(b);
  }
  document.querySelectorAll('.rail-toggle').forEach((b) => (b.onclick = () => {
    railOn[b.dataset.a] = !railOn[b.dataset.a];
    b.classList.toggle('on', railOn[b.dataset.a]);
    const ags = Object.keys(railOn).filter((a) => railOn[a]);
    const f = ['in', ['get', 'a'], ['literal', ags]];
    for (const l of ['rail-lines', 'rail-lines-casing', 'rail-stations', 'rail-names']) map.setFilter(l, f);
  }));
  document.querySelectorAll('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  document.getElementById('lineClose').onclick = () => selectLine(selLine);
  document.getElementById('cabExit').onclick = () => setMode('3d');
  document.getElementById('cabNext').onclick = () => {
    const ids = [...trains.values()].filter((t) => t.moving && t.id !== cabTrain && (!selLine || group(t.r) === selLine)).map((t) => t.id);
    if (ids.length) { cabTrain = ids[Math.floor(Math.random() * ids.length)]; cabBearing = null; }
  };
}

// ---------- boucle d'animation
let lastFrame = 0, lastHud = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!map.getSource('trains') || ts - lastFrame < 33) return;
  lastFrame = ts;
  const now = nowS();
  const feats = [], boxes = [];
  const perGroup = {};
  const three = mode !== 'plan';
  for (const tr of trains.values()) {
    const g = group(tr.r);
    const pos = position(tr, now);
    tr.pos = pos;
    if (!pos) { tr.shown = null; continue; }
    if (pos.dir) tr.head = pos.dir;
    tr.moving = !!pos.dir;
    let p = tr.head ? offsetRight(pos.p, tr.head) : pos.p;
    if (tr.blendFrom) {
      const u = Math.min(1, (now - tr.blendAt) / 1.5);
      if (u >= 1) tr.blendFrom = null;
      else p = [tr.blendFrom[0] + (p[0] - tr.blendFrom[0]) * u, tr.blendFrom[1] + (p[1] - tr.blendFrom[1]) * u];
    }
    tr.shown = p;
    perGroup[g] = (perGroup[g] || 0) + 1;
    if (selLine && g !== selLine) continue;
    const c = routeColor(tr.r);
    feats.push({ type: 'Feature', properties: { k: 'm', id: tr.id, c, t: routeText(tr.r), l: label(tr.r), g, sel: tr.id === popupTrain || tr.id === cabTrain }, geometry: { type: 'Point', coordinates: p } });
    if (three && tr.head && !(mode === 'cab' && tr.id === cabTrain)) boxes.push({ type: 'Feature', properties: { k: 'm', id: tr.id, c, h: 11, b: 1 }, geometry: { type: 'Polygon', coordinates: box(p, tr.head, 140, 9) } });
  }
  let nRail = 0;
  for (const t of rail.values()) {
    const u = Math.min(1, (now - t.t0) / (REFRESH_MS / 1000));
    const p = [t.prev[0] + (t.cur[0] - t.prev[0]) * u, t.prev[1] + (t.cur[1] - t.prev[1]) * u];
    t.shownP = p;
    if (!railOn[t.ag] || selLine) continue;
    nRail++;
    const c = railRoute(t).color;
    feats.push({ type: 'Feature', properties: { k: 'r', id: t.id, c, sel: t.id === popupTrain }, geometry: { type: 'Point', coordinates: p } });
    const dir = t.dir || (t.bearing != null ? [Math.sin(t.bearing * Math.PI / 180) / KX, Math.cos(t.bearing * Math.PI / 180)] : null);
    if (three && dir) boxes.push({ type: 'Feature', properties: { k: 'r', id: t.id, c, h: 14, b: 1 }, geometry: { type: 'Polygon', coordinates: box(p, dir, 220, 10) } });
  }
  map.getSource('trains').setData({ type: 'FeatureCollection', features: feats });
  if (three) map.getSource('trains3d').setData({ type: 'FeatureCollection', features: boxes });
  if (popupTrain && popup) {
    const tr = trains.get(popupTrain) || rail.get(popupTrain);
    const p = tr && (tr.shown || tr.shownP);
    if (p) popup.setLngLat(p);
  }
  if (mode === 'cab') cabCamera();
  if (ts - lastHud > 1000) { lastHud = ts; updateHud(now, perGroup, nRail); }
}

function cabCamera() {
  const tr = trains.get(cabTrain);
  if (!tr || !tr.shown) { cabTrain = pickCabTrain(); if (!cabTrain) setMode('3d'); return; }
  if (!tr.head) return;
  const target = bearingOf(tr.head);
  if (cabBearing == null) cabBearing = target;
  const d = ((target - cabBearing + 540) % 360) - 180;
  cabBearing += d * 0.08;
  const rad = cabBearing * Math.PI / 180;
  // regard vers l'avant depuis la cabine : le centre de la vue est un peu devant la rame
  const ahead = 60;
  const c = [tr.shown[0] + Math.sin(rad) * ahead / M_LON, tr.shown[1] + Math.cos(rad) * ahead / M_LAT];
  map.jumpTo({ center: c, bearing: cabBearing, pitch: 78, zoom: 18.2 });
}

function updateHud(now, perGroup, nRail) {
  const d = new Date(now * 1000);
  document.getElementById('clock').textContent = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  document.getElementById('count').textContent = Object.values(perGroup).reduce((a, b) => a + b, 0);
  document.getElementById('countRail').textContent = rail.size;
  document.querySelectorAll('#legend .bullet').forEach((b) => { b.querySelector('.n').textContent = perGroup[b.dataset.g] || ''; });
  const st = document.getElementById('status');
  const age = lastData ? Math.max(0, Math.round(now - lastData)) : null;
  st.className = statusErr ? 'err' : '';
  st.textContent = statusErr || (age == null ? 'Chargement…' : `Temps réel MTA · mis à jour il y a ${age} s · heure de New York`);
  if (popupTrain && popup) {
    const tr = trains.get(popupTrain);
    if (tr) popup.setHTML(trainHtml(tr)); else { const t = rail.get(popupTrain); if (t) popup.setHTML(railHtml(t)); }
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
  addLayers();
  buildLegend();
  await Promise.all([refresh(), refreshRail()]);
  refreshAlerts();
  setInterval(refresh, REFRESH_MS);
  setInterval(refreshRail, REFRESH_MS);
  setInterval(refreshAlerts, ALERTS_MS);
  requestAnimationFrame(frame);
  const q = new URLSearchParams(location.search);
  if (q.get('line')) selectLine(q.get('line'));
  if (q.get('mode')) setTimeout(() => setMode(q.get('mode')), 1200);
})();
