# Ljubljana // Unrest

A real-time crowd strategy game set in the streets of central Ljubljana. Twelve standalone missions
of 10–20 minutes put you in command of police squads or protest groups: escort a VIP convoy to the
National Assembly, keep a march and a counter-protest apart, carry a banner to the Palace of Justice,
get a dissident speaker out of a kettled square. Every mission has its own win and lose conditions and
a one-to-three-star score, and public opinion and an escalation ladder (force, tear gas, water cannon,
firearms) make every heavy-handed order cost something.

The city is real: buildings, streets, squares, the river, bus stops and CCTV cameras come from open
data. Thousands of people are simulated individually on the GPU. Each one is autonomous, but follows
its group's leader and reacts to crowd density, injuries, gas and police lines. Violence is abstract
(dots and counters), the tone serious.

**Play:** https://virostatiq.com/games/ljubljana-unrest/

## Requirements

A desktop browser with **WebGPU** (recent Chrome / Edge; Firefox and Safari as their WebGPU support
allows). There is no WebGL fallback: the simulation needs compute shaders and atomics. On Linux, Chrome
needs `chrome://flags/#enable-unsafe-webgpu` (and Vulkan). Phones are not supported.

## Running locally

```bash
npm install
npm run dev      # development server
npm run build    # static site in dist/ (relative URLs: works from any subdirectory)
```

Set `SITE_URL=https://example.com/path/` when building to make the share-card tags absolute.

The map data in `public/data/` is pre-built and included. `npm run build:city` regenerates it from a
PostGIS database (see `tools/build_city.py`; the connection comes from `BLOKI_DSN` or the standard
`PG*` environment variables).

## Built with

- [three.js](https://threejs.org/) (MIT): WebGPU renderer, TSL compute shaders for the crowd
- [Tone.js](https://tonejs.github.io/) (MIT): audio
- [Vite](https://vitejs.dev/) (MIT): dev server and build
- [IBM Plex Mono](https://github.com/IBM/plex) (SIL Open Font License 1.1), served by Google Fonts

## Data and attribution

- **Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors**, available under
  the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/); extracts by
  [Geofabrik](https://download.geofabrik.de/). Used for streets, water, parks, railways, CCTV cameras
  and the buildings that the cadastre does not cover. The derived files in `public/data/` (`city.json`,
  `sdf.bin`, `cost.bin`, `cctv.bin`) are a Produced Work under the ODbL.
- **Building footprints © Geodetska uprava Republike Slovenije (GURS)**, Kataster stavb, via
  [e-prostor](https://www.e-prostor.gov.si/), used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **Bus stops © Javno podjetje Ljubljanski potniški promet (LPP)**, LPP's bus-stop export.
- **Sound effects** from [Pixabay](https://pixabay.com/sound-effects/) under the
  [Pixabay Content License](https://pixabay.com/service/license-summary/); each clip and its source is listed in
  [`docs/SOUNDS.md`](docs/SOUNDS.md). The clips are included only as part of this game and may not be
  redistributed on their own. Other sounds are synthesised at runtime.

## Licence

The code is released under the [MIT License](LICENSE): free to use, modify and redistribute, also
commercially, as long as the copyright notice is kept. The map data in `public/data/` and the sounds
in `public/sfx/` keep their own licences (above).

## Note

Some missions are based on real events in Ljubljana; others (The Massacre, BlackBloc, The Court,
Rescue) are fiction.

© 2026 Virostatiq
