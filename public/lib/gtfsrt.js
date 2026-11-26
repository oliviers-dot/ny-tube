// Décodeur GTFS-realtime minimal, sans dépendance, avec les extensions NYCT (champ 1001).
// Lit trip_update, vehicle (avec position GPS pour LIRR / Metro-North) et alert.
// Module universel : utilisable dans Node (require) et dans le navigateur (window.GTFSRT).
(function (root) {
const UTF8 = new TextDecoder('utf-8');

class Reader {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.e = end; }
  more() { return this.p < this.e; }
  varint() {
    let r = 0, mul = 1, byte;
    do { byte = this.b[this.p++]; r += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
    return r;
  }
  tag() { const t = this.varint(); return [Math.floor(t / 8), t & 7]; }
  bytes() { const n = this.varint(); const s = this.p; this.p += n; return [s, this.p]; }
  str() { const [s, e] = this.bytes(); return UTF8.decode(this.b.subarray(s, e)); }
  sub() { const [s, e] = this.bytes(); return new Reader(this.b, s, e); }
  float() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true); this.p += 4; return v; }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.p += 8;
    else if (wt === 2) this.bytes();
    else if (wt === 5) this.p += 4;
    else throw new Error('wire type non géré ' + wt);
  }
}

// int64 négatifs (retards en avance) : varint sur 10 octets
const signed = (v) => (v > 2 ** 63 ? v - 2 ** 64 : v);

function tripDescriptor(r) {
  const t = {};
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) t.trip_id = r.str();
    else if (f === 2 && w === 2) t.start_time = r.str();
    else if (f === 3 && w === 2) t.start_date = r.str();
    else if (f === 5 && w === 2) t.route_id = r.str();
    else if (f === 6 && w === 0) t.direction_id = r.varint();
    else if (f === 1001 && w === 2) {
      const x = r.sub();
      while (x.more()) {
        const [g, v] = x.tag();
        if (g === 1 && v === 2) t.train_id = x.str();
        else if (g === 2 && v === 0) t.is_assigned = !!x.varint();
        else if (g === 3 && v === 0) t.direction = x.varint(); // 1 N, 2 E, 3 S, 4 W
        else x.skip(v);
      }
    } else r.skip(w);
  }
  return t;
}

function vehicleDescriptor(r) {
  const d = {};
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) d.id = r.str();
    else if (f === 2 && w === 2) d.label = r.str();
    else r.skip(w);
  }
  return d;
}

function stopTimeEvent(r) {
  const e = { time: null, delay: null };
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 2 && w === 0) e.time = signed(r.varint());
    else if (f === 1 && w === 0) e.delay = signed(r.varint());
    else r.skip(w);
  }
  return e;
}

function stopTimeUpdate(r) {
  const u = {};
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 4 && w === 2) u.stop_id = r.str();
    else if (f === 2 && w === 2) { const e = stopTimeEvent(r.sub()); u.arrival = e.time; u.arr_delay = e.delay; }
    else if (f === 3 && w === 2) { const e = stopTimeEvent(r.sub()); u.departure = e.time; u.dep_delay = e.delay; }
    else if (f === 1001 && w === 2) {
      const x = r.sub();
      while (x.more()) {
        const [g, v] = x.tag();
        if (g === 2 && v === 2) u.track = x.str();
        else if (g === 1 && v === 2) u.track = u.track || x.str();
        else x.skip(v);
      }
    } else r.skip(w);
  }
  return u;
}

function tripUpdate(r) {
  const tu = { stops: [] };
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) tu.trip = tripDescriptor(r.sub());
    else if (f === 2 && w === 2) tu.stops.push(stopTimeUpdate(r.sub()));
    else if (f === 3 && w === 2) tu.vehicle = vehicleDescriptor(r.sub());
    else if (f === 4 && w === 0) tu.timestamp = r.varint();
    else if (f === 5 && w === 0) tu.delay = signed(r.varint());
    else r.skip(w);
  }
  return tu;
}

function position(r) {
  const p = {};
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 5) p.lat = r.float();
    else if (f === 2 && w === 5) p.lon = r.float();
    else if (f === 3 && w === 5) p.bearing = r.float();
    else if (f === 5 && w === 5) p.speed = r.float();
    else r.skip(w);
  }
  return p;
}

function vehicle(r) {
  const v = {};
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) v.trip = tripDescriptor(r.sub());
    else if (f === 2 && w === 2) v.position = position(r.sub());
    else if (f === 3 && w === 0) v.current_stop_sequence = r.varint();
    else if (f === 4 && w === 0) v.status = r.varint(); // 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO
    else if (f === 5 && w === 0) v.timestamp = r.varint();
    else if (f === 7 && w === 2) v.stop_id = r.str();
    else if (f === 8 && w === 2) v.vehicle = vehicleDescriptor(r.sub());
    else r.skip(w);
  }
  return v;
}

function translated(r) {
  const out = {};
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) {
      const t = r.sub(); let text = '', lang = '';
      while (t.more()) { const [g, v] = t.tag(); if (g === 1 && v === 2) text = t.str(); else if (g === 2 && v === 2) lang = t.str(); else t.skip(v); }
      out[lang || 'en'] = text;
    } else r.skip(w);
  }
  return out.en || out[''] || Object.values(out).find((x) => !/^</.test(x)) || '';
}

function alert(r) {
  const a = { periods: [], entities: [] };
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) {
      const t = r.sub(); const p = {};
      while (t.more()) { const [g, v] = t.tag(); if (g === 1 && v === 0) p.start = t.varint(); else if (g === 2 && v === 0) p.end = t.varint(); else t.skip(v); }
      a.periods.push(p);
    } else if (f === 5 && w === 2) {
      const t = r.sub(); const e = {};
      while (t.more()) {
        const [g, v] = t.tag();
        if (g === 1 && v === 2) e.agency = t.str();
        else if (g === 2 && v === 2) e.route = t.str();
        else if (g === 5 && v === 2) e.stop = t.str();
        else if (g === 6 && v === 0) e.dir = t.varint();
        else t.skip(v);
      }
      a.entities.push(e);
    } else if (f === 10 && w === 2) a.header = translated(r.sub());
    else if (f === 11 && w === 2) a.description = translated(r.sub());
    else if (f === 7 && w === 0) a.effect = r.varint();
    else r.skip(w);
  }
  return a;
}

function decodeFeed(buf) {
  const r = new Reader(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  const out = { timestamp: null, trips: [], vehicles: [], alerts: [] };
  while (r.more()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) {
      const h = r.sub();
      while (h.more()) { const [g, v] = h.tag(); if (g === 3 && v === 0) out.timestamp = h.varint(); else h.skip(v); }
    } else if (f === 2 && w === 2) {
      const e = r.sub(); let id = '';
      while (e.more()) {
        const [g, v] = e.tag();
        if (g === 1 && v === 2) id = e.str();
        else if (g === 3 && v === 2) { const t = tripUpdate(e.sub()); t.eid = id; out.trips.push(t); }
        else if (g === 4 && v === 2) { const t = vehicle(e.sub()); t.eid = id; out.vehicles.push(t); }
        else if (g === 5 && v === 2) { const t = alert(e.sub()); t.id = id; out.alerts.push(t); }
        else e.skip(v);
      }
    } else r.skip(w);
  }
  return out;
}

const BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/';
const FEEDS = ['gtfs', 'gtfs-ace', 'gtfs-bdfm', 'gtfs-g', 'gtfs-jz', 'gtfs-nqrw', 'gtfs-l', 'gtfs-si'];

async function fetchFeed(path, base = BASE) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(base + path, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return decodeFeed(new Uint8Array(await res.arrayBuffer()));
  } finally { clearTimeout(to); }
}

// Identifiant de station « parent » : le temps réel donne 127N / 127S
const parentId = (s) => (s && /[NS]$/.test(s) ? s.slice(0, -1) : s);

// Interroge les 8 flux du métro (sans clé) et renvoie un instantané compact des rames.
async function snapshot(base = BASE) {
  const results = await Promise.allSettled(FEEDS.map((name) => fetchFeed('nyct%2F' + name, base)));
  const trains = [];
  const errors = [];
  let feedTs = 0;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') { errors.push(FEEDS[i] + ': ' + (r.reason && r.reason.message)); return; }
    const feed = r.value;
    feedTs = Math.max(feedTs, feed.timestamp || 0);
    const veh = new Map();
    for (const v of feed.vehicles) if (v.trip && v.trip.trip_id) veh.set(v.trip.trip_id, v);
    for (const tu of feed.trips) {
      const t = tu.trip || {};
      if (!t.trip_id || !tu.stops.length) continue;
      const v = veh.get(t.trip_id) || {};
      const last = tu.stops[tu.stops.length - 1].stop_id || '';
      trains.push({
        id: t.trip_id,
        r: t.route_id,
        d: t.direction === 3 ? 'S' : t.direction === 1 ? 'N' : last.slice(-1),
        n: t.train_id || null,
        a: t.is_assigned !== false,
        st: v.status ?? null,
        vs: parentId(v.stop_id) || null,
        vt: v.timestamp || null,
        s: tu.stops.slice(0, 40).map((u) => [parentId(u.stop_id), u.arrival || u.departure || 0, u.departure || u.arrival || 0, u.track || null]),
      });
    }
  });
  return { now: Math.floor(Date.now() / 1000), feedTs, errors, trains };
}

// Statuts MTA : rang ajouté à l'id d'alerte ("lmm:alert:532243:31"), cf. github.com/nymta/gtfs-documentation
const STATUS = ['', 'No Scheduled Service', 'Information Outage', 'Station Notice', 'Special Notice', 'Weekday Schedule',
  'Weekend Schedule', 'Saturday Schedule', 'Sunday Schedule', 'Extra Service', 'Boarding Change', 'Special Schedule',
  'Expect Delays', 'Reduced Service', 'Planned - Express to Local', 'Planned - Extra Transfer', 'Planned - Stops Skipped',
  'Planned - Detour', 'Planned - Reroute', 'Planned - Substitute Buses', 'Planned - Part Suspended', 'Planned - Suspended',
  'Service Change', 'Planned Work', 'Some Delays', 'Express to Local', 'Delays', 'Cancellations', 'Delays and Cancellations',
  'Stops Skipped', 'Severe Delays', 'Detour', 'Reroute', 'Substitute Buses', 'Part Suspended', 'Suspended'];

async function alerts(path = 'camsys%2Fsubway-alerts', base = BASE) {
  const feed = await fetchFeed(path, base);
  const now = Date.now() / 1000;
  return feed.alerts
    .filter((a) => !a.periods.length || a.periods.some((p) => (!p.start || p.start <= now) && (!p.end || p.end >= now)))
    .map((a) => {
      const rank = +(a.id.split(':').pop()) || 0;
      return { id: a.id, rank, status: STATUS[rank] || '', header: a.header || '', description: a.description || '',
        routes: [...new Set(a.entities.map((e) => e.route).filter(Boolean))],
        stops: [...new Set(a.entities.map((e) => e.stop).filter(Boolean))] };
    });
}

const api = { decodeFeed, fetchFeed, snapshot, alerts, STATUS, FEEDS, BASE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.GTFSRT = api;
})(typeof self !== 'undefined' ? self : this);
