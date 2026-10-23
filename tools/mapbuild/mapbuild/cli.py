"""Build a map from OpenStreetMap: settings in maps/<city>/<area>.json, output in public/data/<city>/<area>/.

    npm run build:map -- belgrade/centre             download (once), clip, build, write
    npm run build:map -- belgrade/centre --check     build and compare with the files already there, write nothing
    npm run build:map -- belgrade/centre --refresh   download the region extract again first
"""
import argparse
import json
import sys
import time
from pathlib import Path

from . import compose, config, fetch, osm
from .config import ROOT


def names(city):
    """What missions refer to by name: places, landmarks, targets, map-edge entries."""
    return {
        "places": {p["name"] for p in city["pois"] if p["kind"] == "place"},
        "landmarks": {l["name"] for l in city["landmarks"]},
        "targets": set(city["targets"]),
        "entries": {e["name"] for e in city["entries"] if e["name"]},
    }


def compare(old, new):
    """Names the new build lost; returns True when nothing a mission could use went missing."""
    a, b = names(old), names(new)
    ok = True
    for k in a:
        if gone := sorted(a[k] - b[k]):
            ok = False
            print(f"lost {k}: {', '.join(gone)}", file=sys.stderr)
        if added := sorted(b[k] - a[k]):
            print(f"new {k}: {', '.join(added)}", file=sys.stderr)
    for k in ("buildings", "pois", "labels"):
        print(f"{k}: {len(old[k])} → {len(new[k])}", file=sys.stderr)
    return ok


def write(out, city, rasters, editor, m):
    editor["built"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    fetch.editor_file(m).write_text(json.dumps(editor, ensure_ascii=False, separators=(",", ":")))
    out.mkdir(parents=True, exist_ok=True)
    for name, arr in rasters.items():
        arr.tofile(out / name)
    with open(out / "city.json", "w") as fh:
        json.dump(city, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}: city.json "
          f"{(out / 'city.json').stat().st_size >> 10} KB", file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mapbuild", description=__doc__.split("\n")[0])
    ap.add_argument("map", help="<city>/<area> (maps/<city>/<area>.json) or a path to a settings file")
    ap.add_argument("--check", action="store_true", help="compare with the existing output and write nothing; "
                                                          "exits 1 if a place, landmark, target or entry disappeared")
    ap.add_argument("--refresh", action="store_true", help="download the region extract again")
    ap.add_argument("--out", type=Path, help="output folder (default public/data/<city>/<area>/)")
    a = ap.parse_args(argv)
    try:
        m = config.load(a.map)
    except config.ConfigError as e:
        sys.exit(f"mapbuild: {e}")
    out = (a.out or ROOT / "public" / "data" / m.city / m.area).resolve()

    t = time.time()
    pbf, source = fetch.map_pbf(m, a.refresh)
    F = osm.load(pbf, m)
    city, rasters, editor = compose.compose(F, m, source)
    print(f"built {m.id} in {time.time() - t:.0f} s", file=sys.stderr)

    old = out / "city.json"
    if a.check:
        if not old.exists():
            sys.exit(f"mapbuild: nothing to compare with in {out}")
        sys.exit(0 if compare(json.loads(old.read_text()), city) else 1)
    if old.exists():
        compare(json.loads(old.read_text()), city)
    write(out, city, rasters, editor, m)


if __name__ == "__main__":
    main()
