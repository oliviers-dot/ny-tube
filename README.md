# NY Tube

Le métro de New York, le LIRR et Metro-North **en temps réel** sur une carte du grand Manhattan,
dans l'esprit de scanpaname.com. Site : https://oliviers-dot.github.io/ny-tube/

## Ce que fait l'appli

- **Métro** : les ~450 rames en circulation, animées le long des vrais tracés. Les deux sens sont
  décalés de part et d'autre de la voie.
- **LIRR et Metro-North** : positions GPS des trains (flux MTA), lissées entre deux relevés, en
  sous-couche (tracés en pointillés).
- **Clic sur une ligne** (pastille en haut à gauche, ou sur le tracé) : la ligne est isolée sur la
  carte, et un panneau affiche son trajet complet en plan de ligne, les rames qui y circulent dans
  chaque sens, et l'état du trafic (alertes MTA, « Good Service » sinon).
- **Vues** : Plan, 3D (bâtiments en relief, rames en volume), Sous-sol (fond de carte et bâtiments
  estompés, lignes lumineuses) et Cabine (caméra qui suit une rame, vue vers l'avant).
- Clic sur une rame : destination, prochains arrêts, accès à la vue cabine. Clic sur une station :
  prochains passages et alertes.
- Liens directs : `?line=A`, `?mode=3d`, `?mode=cab`, et la position de carte dans l'URL.

## Lancer en local

```bash
node server.js        # Node 18+, aucune dépendance
# puis http://localhost:8080
```

`public/` est un site statique autonome : le navigateur interroge directement les flux MTA
(sans clé, CORS ouvert). `server.js` ne sert que de serveur local et de relais de secours
(`?src=api`). Chaque push sur `main` republie `public/` sur GitHub Pages
(`.github/workflows/pages.yml`).

## Données

- Temps réel (GTFS-realtime, https://gtfs.org/documentation/realtime/reference/) :
  8 flux métro `nyct/gtfs*` (TripUpdate + extensions NYCT), `lirr/gtfs-lirr` et `mnr/gtfs-mnr`
  (VehiclePosition GPS), `camsys/subway-alerts` (Alert). Décodeur protobuf maison sans dépendance :
  `public/lib/gtfsrt.js`.
- Gravité des alertes : rang ajouté à l'id d'alerte par la MTA
  (https://github.com/nymta/gtfs-documentation, de 1 « No Scheduled Service » à 35 « Suspended »).
- Statique : GTFS officiel MTA (`gtfs_subway.zip`, `gtfslirr.zip`, `gtfsmnr.zip` sur
  rrgtfsfeeds.s3.amazonaws.com) transformé par `tools/build_static.py` et `tools/build_rail.py`.

## Hypothèses

- La MTA ne publie pas de GPS pour le métro : la position est **estimée**. Départ de la station
  précédente = arrivée prévue à la suivante moins le temps de parcours théorique (médiane du GTFS).
- Station précédente : celle où la MTA signale la rame à quai, sinon le gabarit de ligne (suffixe du
  trip_id, ex. `1..S03R`), sinon la plus fréquente sur la ligne et le sens.
- Rames masquées : pas encore parties de leur terminus et non suivies, ou prévisions figées
  depuis plus de 10 min.
- La vue Sous-sol est une vue « rayons X » : MapLibre ne sait pas dessiner sous le sol, la
  profondeur réelle des tunnels n'est pas représentée.

## Mettre à jour les données statiques

```bash
curl -O https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip && unzip -o gtfs_subway.zip -d gtfs
python3 tools/build_static.py gtfs public/data/static.json
```
