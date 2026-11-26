#!/usr/bin/env python3
"""Construit public/data/rail.json (LIRR + Metro-North) à partir des fichiers de la couche rail
(rail_lines.geojson, rail_stations.geojson, rail_schedule_*.json, eux-mêmes tirés des GTFS
https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip et gtfsmnr.zip).
Usage : python3 tools/build_rail.py <dossier_data_rail> <sortie.json>"""
import json, sys, glob, os
src, out = sys.argv[1], sys.argv[2]
sched = json.load(open(sorted(glob.glob(os.path.join(src, 'rail_schedule_*.json')))[-1]))
key = {'LIRR': 'LIRR', 'Metro-North': 'MNR'}
lines = json.load(open(os.path.join(src, 'rail_lines.geojson')))
stations = json.load(open(os.path.join(src, 'rail_stations.geojson')))
res = {'routes': {}, 'stations': {}, 'lines': []}
for ag, d in sched['agencies'].items():
    res['routes'][key[ag]] = d['routes']
for f in lines['features']:
    p = f['properties']
    res['lines'].append({'a': key[p['agency']], 'r': p['route_id'], 'c': p['color'], 'p': f['geometry']['coordinates']})
for f in stations['features']:
    p = f['properties']
    res['stations'].setdefault(key[p['agency']], {})[p['stop_id']] = [p['name']] + f['geometry']['coordinates']
json.dump(res, open(out, 'w'), separators=(',', ':'))
print('lignes', len(res['lines']), 'octets', os.path.getsize(out))
