# Map build system: handoff

For an agent picking up the map work on branch `feature/map-build`. The user-facing docs are
[maps/README.md](../maps/README.md) (settings format, editor, build) and the Maps section of
[PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md#maps) (using a map in a scenario). This page is the map of the code and
the decisions behind it.

## What it is

Cordon Bleu started with Ljubljana only, built from a PostGIS database that other contributors don't have. The
new system builds maps of any city from OpenStreetMap: a settings file per play area → a Python build → the same
`city.json` + rasters the game already loads → missions pick the map with `city` and `map`. Belgrade and Paris are
the next cities; their districts are not chosen yet.

## Decisions to keep

- **Ljubljana is left alone.** Its maps stay `public/data/` (centre) and `public/data/north/`, built by
  `tools/build_city.py` from PostGIS in EPSG:3794. `mapbuild` and the editor refuse `ljubljana`. Moving Ljubljana
  to a local projection would rotate it by ~0.35° and shift hand-placed mission coordinates by metres.
- **Output format unchanged.** `tools/mapbuild` writes what `build_city.py` writes (`city.json`, `sdf.bin`,
  `cost.bin`, `cctv.bin`) plus `format`, `crs` and `source` fields. The client needed no format changes.
- **Local coordinates:** a transverse Mercator centred on the map's `center`, so the origin is (0, 0).
- **Built output is committed to plain git, not LFS.** It compresses to about 2 MB per rebuild. Rebuilds are
  reviewed changes; OSM edits must not change maps silently, so there is no build in CI.
- **Names are the contract between maps and missions.** Scenarios refer to `place()`, `target()` and `landmark()` by
  name. Every build prints the names that appeared or disappeared, and `--check` exits 1 on a loss.
- **Toolchain:** Python through `uv` only. pyosmium clips the extract itself, so `osmium-tool` is not needed.

## Code

| Path | What |
|---|---|
| `maps/<city>/<area>.json` | settings per play area (format in maps/README.md) |
| `tools/mapbuild/mapbuild/config.py` | loads and validates settings; the projection |
| `tools/mapbuild/mapbuild/fetch.py` | picks the smallest Geofabrik region (`index-v1.json`), downloads it, clips it to the box + 500 m with `BackReferenceWriter` |
| `tools/mapbuild/mapbuild/osm.py` | **all OSM tag rules**: road classes, parks, water, POIs, landmark kinds and tiers, Serbian transliteration |
| `tools/mapbuild/mapbuild/compose.py` | geometry and rasters, ported from `build_city.py`; landmarks, targets with exits, entries; the editor sidecar |
| `tools/mapbuild/mapbuild/route.py` | fastest car route (scipy Dijkstra, one-way aware); replaces pgRouting |
| `tools/mapbuild/mapbuild/cli.py` | `npm run build:map -- <city>/<area> [--check] [--refresh] [--out DIR]` |
| `tools/editor/` | `npm run editor`: Leaflet page (`editor.ts`) + Vite dev-server API (`plugin.ts`, `/__maps`) |
| `src/game/cities.ts` | `mapOf()`: mission → map folder; `citiesFor()`: landing-page cities |
| `src/main.ts` | loads `mapOf( M ).base`; `/?map=<city>/<area>` preview (`hud.preview`) |

Cache (git-ignored): `.cache/osm/` region extracts, `.cache/maps/<city>-<area>.osm.pbf` clipped extract,
`.cache/maps/<city>-<area>.editor.json` sidecar the editor draws (buildings with OSM ids, landmark candidates,
route, entries, exits, in lon/lat).

## Things that are not obvious

- **Landmark tiers** (`osm.landmark_kind` returns `(kind, auto)`): only seats of power (parliament, presidency,
  ministries, town halls, courts), police, hospitals, embassies, TV/radio studios, main stations and cathedrals are
  automatic. Other `office=government` objects are suggestions the editor shows. Tagging them all gave 115 "gov"
  buildings in central Belgrade.
- **Separately mapped sidewalks and crossings are skipped** (`STREET_FOOTWAYS`). Paris maps them everywhere, and
  the road buffers already cover them.
- **A target relabels the landmark on its footprint,** so a building gets one label, not the OSM name and the
  target label.
- **Clip cost:** the first build of a region downloads 240–340 MB and clips in about 40–80 s with about 3 GB of RAM.
  Moving or resizing the area re-clips; otherwise a build takes 3–6 s.
- **Editor drawing:** buildings are one Leaflet multipolygon per style, and clicks find their building through
  a grid index (`buildingAt`). Thousands of separate polygons froze the page.
- **Editor coordinates** use a local metres-per-degree approximation, under 1 m off the build's projection over a
  few km. That is fine for the rectangle and overlays; the build itself is exact.
- **Old map form:** `city: 'north'` without `map` still means Ljubljana's north map (`mapOf`, tested in
  `tests/cities.test.ts`).

## Checking work

```bash
npm run typecheck && npm test            # game + SDK
npm run test:map                         # mapbuild unit tests
npm run build:map -- <city>/<area>       # prints counts and the names diff
npm run editor                           # then "Open in the game" for /?map=<city>/<area>
```

To try a scenario on a new map, put a plugin under the git-ignored `.cache/` and open
`/?plugin=/.cache/<file>.ts&m=<id>`. WebGPU is needed for the game (on Linux Chrome:
`chrome://flags/#enable-unsafe-webgpu`), not for the editor.

## Open

- Belgrade and Paris districts are not chosen; the user is reading up on historical unrest first. The intended
  theatre is about 3.2 × 2.9 km, like Ljubljana's centre.
- No built-in mission plays outside Ljubljana yet. Built-ins and the defend template name Ljubljana places, so a
  scenario on another map must name its own.
- In one test, dragging the editor's corner handle panned the map instead of resizing; a retry worked. It might be
  a collision with a running zoom animation; it was not reproduced or fixed.
- `PLUGIN_AUTHORING.md` asks for `tsc` on `src/game/scenarios/index.d.ts`, which does not exist; the SDK typings are
  checked by `tsconfig.sdk.json` in `npm run typecheck`.
