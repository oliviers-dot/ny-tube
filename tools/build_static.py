#!/usr/bin/env python3
"""Construit public/data/static.json à partir du GTFS statique du métro (MTA).

Usage : python3 tools/build_static.py <dossier_gtfs_dézippé> <sortie.json>
Source : https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip (publié par la MTA,
le même jeu que celui référencé dans le catalogue open data data.ny.gov).

Produit :
  routes    : couleur et nom de chaque ligne
  stations  : stations « parent » (id, nom, lat, lon, lignes desservies)
  shapes    : tracé simplifié de chaque gabarit de ligne (pour dessiner les lignes)
  patterns  : clé de gabarit (ex. "1..S03R") -> suite ordonnée de stations
  segments  : "A>B" -> {p: polyligne entre A et B suivant le tracé, t: temps de parcours médian (s)}
"""
import csv, json, math, os, statistics, sys
from collections import defaultdict

src, out = sys.argv[1], sys.argv[2]

def rows(name):
    with open(os.path.join(src, name), newline='', encoding='utf-8-sig') as f:
        yield from csv.DictReader(f)

def hms(s):
    h, m, x = s.split(':')
    return int(h) * 3600 + int(m) * 60 + int(x)

# --- lignes
routes = {}
for r in rows('routes.txt'):
    routes[r['route_id']] = {
        'name': r['route_short_name'] or r['route_id'],
        'long': r['route_long_name'],
        'color': '#' + (r['route_color'] or '808183'),
        'text': '#' + (r['route_text_color'] or 'FFFFFF'),
    }

# --- stations
stops = {}
parent = {}
for s in rows('stops.txt'):
    sid = s['stop_id']
    parent[sid] = s['parent_station'] or sid
    if s['location_type'] == '1' or not s['parent_station']:
        stops[sid] = {'id': sid, 'name': s['stop_name'],
                      'lat': round(float(s['stop_lat']), 6), 'lon': round(float(s['stop_lon']), 6),
                      'routes': set()}

# --- tracés
shape_pts = defaultdict(list)
for p in rows('shapes.txt'):
    shape_pts[p['shape_id']].append((int(p['shape_pt_sequence']), float(p['shape_pt_lon']), float(p['shape_pt_lat'])))
for k in shape_pts:
    shape_pts[k] = [(lon, lat) for _, lon, lat in sorted(shape_pts[k])]

# --- voyages
trip_shape, trip_route = {}, {}
for t in rows('trips.txt'):
    trip_shape[t['trip_id']] = t['shape_id'] or t['trip_id'].split('_')[-1]
    trip_route[t['trip_id']] = t['route_id']

# --- horaires : séquences de stations par voyage
seq = defaultdict(list)
for st in rows('stop_times.txt'):
    seq[st['trip_id']].append((int(st['stop_sequence']), parent.get(st['stop_id'], st['stop_id']),
                               hms(st['arrival_time']), hms(st['departure_time'])))

patterns = {}          # clé de gabarit -> stations (on garde la plus longue)
pattern_shape = {}
run_times = defaultdict(list)
pair_shape = {}        # "A>B" -> shape_id servant à découper le segment
for tid, lst in seq.items():
    lst.sort()
    stations = [x[1] for x in lst]
    key = tid.split('_')[-1]            # ex. "1..S03R" (identique au suffixe des trip_id temps réel)
    if len(stations) > len(patterns.get(key, [])):
        patterns[key] = stations
        pattern_shape[key] = trip_shape.get(tid)
    r = trip_route.get(tid)
    for s in stations:
        if s in stops and r:
            stops[s]['routes'].add(r)
    for a, b in zip(lst, lst[1:]):
        k = a[1] + '>' + b[1]
        run_times[k].append(max(30, b[2] - a[3]))
        if k not in pair_shape and trip_shape.get(tid) in shape_pts:
            pair_shape[k] = trip_shape[tid]

# --- découpage des segments le long des tracés
def d2(a, b):
    kx = math.cos(math.radians(40.75))
    return ((a[0] - b[0]) * kx) ** 2 + (a[1] - b[1]) ** 2

def nearest(pts, p, lo=0):
    best, bi = 1e18, lo
    for i in range(lo, len(pts)):
        d = d2(pts[i], p)
        if d < best:
            best, bi = d, i
    return bi, best

segments = {}
for k, times in run_times.items():
    a, b = k.split('>')
    if a not in stops or b not in stops:
        continue
    A = (stops[a]['lon'], stops[a]['lat'])
    B = (stops[b]['lon'], stops[b]['lat'])
    poly = [A, B]
    sh = shape_pts.get(pair_shape.get(k))
    if sh:
        ia, da = nearest(sh, A)
        ib, db = nearest(sh, B)
        # tolérance ~300 m ; sinon on retombe sur une ligne droite
        if da < 3e-6 * 3 and db < 3e-6 * 3 and ia != ib:
            mid = sh[ia:ib + 1] if ia < ib else list(reversed(sh[ib:ia + 1]))
            poly = [A] + mid[1:-1] + [B]
    segments[k] = {'p': [[round(x, 5), round(y, 5)] for x, y in poly],
                   't': int(statistics.median(times))}

# --- tracés à dessiner : un par gabarit retenu, dédoublonnés
draw = {}
for key, sid in pattern_shape.items():
    if sid in shape_pts and sid not in draw:
        r = key.split('.')[0]
        pts = shape_pts[sid]
        # simplification grossière : un point sur deux sauf extrémités
        simp = pts[::2] + ([pts[-1]] if len(pts) % 2 == 0 else [])
        draw[sid] = {'route': r, 'p': [[round(x, 5), round(y, 5)] for x, y in simp]}

out_obj = {
    'routes': routes,
    'stations': [dict(v, routes=sorted(v['routes'])) for v in stops.values() if v['routes']],
    'shapes': list(draw.values()),
    'patterns': patterns,
    'segments': segments,
}
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'w') as f:
    json.dump(out_obj, f, separators=(',', ':'))
print('stations', len(out_obj['stations']), 'segments', len(segments), 'patterns', len(patterns),
      'shapes', len(draw), 'bytes', os.path.getsize(out))
