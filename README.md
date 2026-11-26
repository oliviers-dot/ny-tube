# NY Tube

Le métro de New York, le LIRR et Metro-North **en temps réel** sur une carte du grand Manhattan,
dans l'esprit de scanpaname.com. Site : https://oliviers-dot.github.io/ny-tube/

## Ce que fait l'appli

- **Tout est éteint au démarrage.** On allume les lignes qui nous intéressent (pastilles du métro,
  branches LIRR et Metro-North) et elles passent en direct. Seuls les flux MTA de ces lignes sont
  téléchargés : allumer la A ne charge que le flux A/C/E, pas les huit flux du métro.
- **Métro** : rames animées le long des vrais tracés à partir des prévisions d'arrivée MTA. Les deux
  sens sont décalés de part et d'autre de la voie. Les lignes éteintes restent en gris fin, pour le repère.
- **LIRR et Metro-North** : positions GPS calées sur les voies, puis avance continue à la vitesse
  mesurée entre deux relevés ; un écart au relevé suivant est rattrapé en douceur.
- **Direct** : les flux sont interrogés toutes les 10 s ; un flux inchangé est ignoré (les rames
  continuent de rouler sans à-coup), un flux en erreur garde ses dernières données. Le direct se met
  en pause quand l'onglet est caché et repart dès qu'on revient.
- **Panneau de ligne** : en allumant une ligne, son trajet complet, ses rames dans chaque sens et
  l'état du trafic (alertes MTA) s'affichent. Avec plusieurs lignes allumées, des onglets en haut du
  panneau passent de l'une à l'autre.
- **Vues** : Plan, 3D (bâtiments en relief, rames en volume, glisser pour tourner), Sous-sol et
  Cabine (vue du conducteur).
- Liens directs : `?lines=A,C,E&rail=LIRR:1,MNR` (branche ou compagnie entière), `?mode=3d`, `?mode=cab`.

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
