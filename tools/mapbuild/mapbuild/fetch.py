"""OSM data: the smallest Geofabrik extract that covers a map, downloaded once, then clipped to the map.

Cache (git-ignored):
    .cache/osm/index-v1.json              Geofabrik's region index (refreshed after a week)
    .cache/osm/<region>-latest.osm.pbf    the region extract (re-downloaded with --refresh)
    .cache/maps/<city>-<area>.osm.pbf     the map's bbox (+ margin), reference-complete
"""
import hashlib
import json
import sys
import time
import urllib.request

import osmium
from shapely.geometry import box, shape

from .config import ROOT

INDEX_URL = "https://download.geofabrik.de/index-v1.json"
CACHE = ROOT / ".cache"
UA = {"User-Agent": "cordon-bleu-mapbuild (+https://github.com/virostatiq/ljubljana-unrest)"}
MARGIN = 500.0  # m of data around the play area: roads that leave it, the routing network


def _download(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(path.suffix + ".part")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r, open(part, "wb") as fh:
        total = int(r.headers.get("Content-Length") or 0)
        done, shown = 0, -1
        while chunk := r.read(1 << 20):
            fh.write(chunk)
            done += len(chunk)
            if total and (pct := done * 10 // total) != shown:
                shown = pct
                print(f"  {url.rsplit('/', 1)[-1]}: {done >> 20} / {total >> 20} MB", file=sys.stderr)
    part.rename(path)


def region(lonlat_box):
    """The smallest Geofabrik region whose outline contains the box: (id, pbf url)."""
    idx = CACHE / "osm" / "index-v1.json"
    if not idx.exists() or time.time() - idx.stat().st_mtime > 7 * 86400:
        _download(INDEX_URL, idx)
    want = box(*lonlat_box)
    best = None
    for f in json.loads(idx.read_text())["features"]:
        url = f["properties"].get("urls", {}).get("pbf")
        if not url or not f.get("geometry"):
            continue
        g = shape(f["geometry"])
        if g.contains(want) and (best is None or g.area < best[0]):
            best = (g.area, f["properties"]["id"], url)
    if best is None:
        raise SystemExit("no Geofabrik extract covers this map")
    return best[1], best[2]


def region_pbf(lonlat_box, refresh=False):
    rid, url = region(lonlat_box)
    path = CACHE / "osm" / f"{rid.replace('/', '-')}-latest.osm.pbf"
    if refresh or not path.exists():
        print(f"downloading {url}", file=sys.stderr)
        _download(url, path)
    return rid, path


def timestamp(pbf):
    h = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING).header()
    return h.get("osmosis_replication_timestamp") or h.get("timestamp") or None


def clip(src, lonlat_box, dst):
    """Copy everything in the box into dst, with the nodes of its ways and the members of its multipolygons.

    Kept: tagged nodes inside the box, ways with a node inside it, multipolygon relations with such a way.
    """
    x0, y0, x1, y1 = lonlat_box

    def inside(loc):
        return loc.valid() and x0 <= loc.lon <= x1 and y0 <= loc.lat <= y1

    ways = set()
    fp = (osmium.FileProcessor(str(src)).with_locations()
          .with_filter(osmium.filter.EmptyTagFilter().enable_for(osmium.osm.NODE)))
    dst.parent.mkdir(parents=True, exist_ok=True)
    with osmium.BackReferenceWriter(str(dst), ref_src=str(src), overwrite=True) as w:
        for o in fp:
            if o.is_node():
                if inside(o.location):
                    w.add_node(o)
            elif o.is_way():
                if any(inside(n.location) for n in o.nodes):
                    ways.add(o.id)
                    w.add_way(o)
            elif o.tags.get("type") == "multipolygon" and any(m.type == "w" and m.ref in ways for m in o.members):
                w.add_relation(o)


def map_pbf(m, refresh=False):
    """The map's clipped extract, rebuilt when the region extract or the box changed. Returns (path, source)."""
    lbox = m.lonlat_box(MARGIN)
    rid, src = region_pbf(lbox, refresh)
    key = hashlib.sha1(f"{src.stat().st_mtime_ns}:{lbox}".encode()).hexdigest()[:12]
    dst = CACHE / "maps" / f"{m.city}-{m.area}.osm.pbf"
    stamp = dst.with_suffix(".key")
    if not dst.exists() or not stamp.exists() or stamp.read_text() != key:
        print(f"clipping {src.name} to {m.id}", file=sys.stderr)
        t = time.time()
        clip(src, lbox, dst)
        stamp.write_text(key)
        print(f"  {dst.stat().st_size >> 10} KB in {time.time() - t:.0f} s", file=sys.stderr)
    return dst, {"extract": f"geofabrik:{rid}", "timestamp": timestamp(src)}
