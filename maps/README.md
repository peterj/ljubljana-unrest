# Map settings

Each file `maps/<city>/<area>.json` describes one play area. `npm run build:map -- <city>/<area>` builds it from
OpenStreetMap into `public/data/<city>/<area>/` (`city.json`, `sdf.bin`, `cost.bin`, `cctv.bin`; the format
`src/city.ts` loads). The Ljubljana maps are not built this way: they come from a PostGIS database through
`tools/build_city.py` (`npm run build:city`).

## Editor

`npm run editor` opens the map editor (`tools/editor/`, on the Vite dev server only):

- **New** places a 3.2 × 2.9 km play area at the centre of the view. Drag its orange handles to move it or to
  resize it about its centre, or press **⌖ Set** next to the centre and click the map to move it there.
- **Add place** and **Route start / end** set places and the convoy route by clicking the map.
- After a build, clicking a building makes it a **target** or a **landmark**. The pins are the landmarks found by
  tags (filled) and the suggestions the build left out (hollow): click one to drop, rename or add it.
- **Save** writes the settings file, **Build** runs the build and streams its log, **Raster** overlays the
  walking cost, distance and CCTV grids the game will use.

## Using a map in a scenario

A scenario picks the map with `city: '<city>', map: '<area>'` and refers to what the settings name: `place(name)`,
`target(label)` and `landmark(name)`. See [docs/PLUGIN_AUTHORING.md](../docs/PLUGIN_AUTHORING.md#maps).
`/?map=<city>/<area>` (the editor's "Open in the game") shows the built map in the game without a scenario.

## Requirements

[uv](https://docs.astral.sh/uv/) installs Python and the dependencies (pyosmium, shapely, pyproj, scipy, numpy,
Pillow) on the first run. Nothing else is needed.

The first build of a city downloads the smallest [Geofabrik](https://download.geofabrik.de/) extract that covers
it (Serbia ~240 MB, Île-de-France ~350 MB) into `.cache/osm/` and clips it to the area (about a minute, and a few GB
of memory for a large region). Later builds take seconds. `--refresh` downloads the extract again for newer data.

```bash
npm run build:map -- belgrade/centre            # build and write
npm run build:map -- belgrade/centre --check    # compare with the files already there, write nothing
npm run test:map                                # unit tests of the build tool
```

Every build lists the places, landmarks, targets and map-edge entries that appeared or disappeared since the
previous build. Missions refer to these by name, so review a rebuild before committing it. `--check` exits
with 1 when something disappeared.

## Format

```jsonc
{
  "name": "Centre",
  "center": [20.4603, 44.8166],          // [lon, lat]: the origin of the local coordinates
  "size": [3200, 2900],                  // metres east-west and north-south, multiples of 4, at most 8192
  "names": ["name:sr-Latn", "name"],     // tags to take names from, first present wins (default ["name"])
  "transliterate": "sr",                 // Cyrillic names without a Latin tag to Latin letters (optional)
  "places": [{ "name": "Trg Nikole Pašića", "at": [20.4632, 44.8120] }],
  "route": { "from": [20.4480, 44.8050], "to": [20.4655, 44.8117] },
  "targets": [{ "label": "Narodna skupština", "osm": "way/24418034" }],
  "landmarks": {
    "auto": true,
    "add": [{ "kind": "gov", "label": "Ministarstvo odbrane", "osm": "way/123" }],
    "drop": ["node/456"],
    "rename": { "way/789": "Vlada" }
  }
}
```

Only `name`, `center` and `size` are required.

- **Coordinates** in the game are metres from `center` (+x east, +y north), in a transverse Mercator projection
  centred there. `city.json` records it as `crs`.
- **places** are the named open spaces that missions use as anchors and that the map labels.
- **route** is the convoy route: the fastest way by car from `from` to `to`, one-way streets respected.
- **targets** are buildings to defend or take, by OSM id. Each gets a footprint, a radius and up to three
  evacuation exits on nearby streets, and is a landmark under its `label` (a landmark on the footprint takes the
  label).
- **landmarks** are labelled and coloured buildings (`kind`: gov, police, hospital, embassy, media, transit,
  landmark). With `auto`, the build picks them from OSM tags: police stations, hospitals, town halls, courts,
  parliament, presidency and ministries (`government=legislative|presidency|ministry|…`), embassies, TV and
  radio studios, main railway stations, cathedrals. Other government offices are left out unless added. `drop`
  removes one, `rename` relabels one, and `add` names any OSM object as a landmark.

OSM ids are `node/<n>`, `way/<n>` or `relation/<n>`, as in the URL of the object on openstreetmap.org.

## Data licence

The output is a Produced Work of OpenStreetMap data, © OpenStreetMap contributors, under the
[ODbL](https://opendatacommons.org/licenses/odbl/). `city.json` records the extract and its date as `source`.
