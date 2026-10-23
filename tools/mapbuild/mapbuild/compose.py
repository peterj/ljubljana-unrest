"""Turn Features into city.json and its rasters: the same format as tools/build_city.py writes for Ljubljana.

Outputs (local metres, origin = the map's center, +x east, +y north):
    city.json   vector geometry for rendering + POIs + grid metadata
    sdf.bin     Int8, 1 m cells: signed distance to nearest obstacle (dm, clamped ±12.7 m)
    cost.bin    Uint8, 4 m cells: traversal cost for flow fields (255 = blocked)
    cctv.bin    Uint8, 4 m cells: number of cameras that see the cell
"""
import sys

import numpy as np
from pyproj import Transformer
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import route as routing
from .osm import ROAD_CLASSES

FORMAT = 1
SDF_RES = 1.0
COST_RES = 4.0
CCTV_R = 35.0


def log(*a):
    print(*a, file=sys.stderr)


def r1(v):
    return round(float(v), 1)


def loc(x, y):
    return r1(x), r1(y)


def ring_coords(ring):
    out = []
    for x, y in list(ring.coords)[:-1]:
        out += [r1(x), r1(y)]
    return out


def polys(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def enc_poly(p, min_area=0.0):
    if p.area < min_area:
        return None
    return [ring_coords(p.exterior)] + [ring_coords(r) for r in p.interiors if Polygon(r).area > 4]


def enc_line(ls):
    out = []
    for x, y in ls.coords:
        out += [r1(x), r1(y)]
    return out


def lines_of(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if g.geom_type == "LineString"]


def compose(F, m, source):
    MIN_X, MIN_Y, MAX_X, MAX_Y = m.box
    CLIP = box(MIN_X, MIN_Y, MAX_X, MAX_Y)
    T = m.to_local()

    def at(lonlat):
        return T.transform(*lonlat)

    # ---------- buildings ----------
    buildings = []
    for oid, g in F.buildings:
        for p in polys(g.simplify(0.4).intersection(CLIP)):
            if p.area >= 6:
                buildings.append({"osm": oid, "poly": p, "kind": None, "name": None})
    log("buildings", len(buildings))
    tree = STRtree([b["poly"] for b in buildings])

    def tag_buildings(geom, kind, name):
        if geom.geom_type == "Point":
            idx = tree.query_nearest(geom, max_distance=25)
            for i in idx[:1]:
                buildings[i]["kind"], buildings[i]["name"] = kind, name
            return len(idx[:1])
        hit = 0
        for i in tree.query(geom):
            b = buildings[i]
            inter = b["poly"].intersection(geom).area
            if inter > 0.5 * b["poly"].area or inter > 0.5 * geom.area:
                b["kind"], b["name"] = kind, name
                hit += 1
        return hit

    # ---------- landmarks: found by tags, then the settings add, drop and rename ----------
    lm = m.landmarks
    picked = []
    if lm["auto"]:
        for c in F.candidates:
            if not c["auto"] or c["osm"] in lm["drop"] or not CLIP.contains(c["geom"].representative_point()):
                continue
            name = lm["rename"].get(c["osm"], c["name"])
            if name:
                picked.append({"osm": c["osm"], "kind": c["kind"], "name": name, "geom": c["geom"]})
    for a in lm["add"]:
        if a["osm"] not in F.refs:
            log(f"warning: landmark {a['label']}: {a['osm']} is not in the extract")
            continue
        picked = [p for p in picked if p["osm"] != a["osm"]]
        picked.append({"osm": a["osm"], "kind": a["kind"], "name": a["label"], "geom": F.refs[a["osm"]][0]})
    # one landmark per kind and name within 80 m (a police station is often a node and a building); areas first
    picked.sort(key=lambda p: p["geom"].geom_type == "Point")
    landmarks = []
    for p in picked:
        c = p["geom"].representative_point() if p["geom"].geom_type != "Point" else p["geom"]
        if any(q["kind"] == p["kind"] and q["name"] == p["name"] and c.distance(q["c"]) < 80 for q in landmarks):
            continue
        tag_buildings(p["geom"], p["kind"], p["name"])
        landmarks.append({**p, "c": c})
    log("landmarks", {k: sum(1 for p in landmarks if p["kind"] == k) for k in sorted({p["kind"] for p in landmarks})})

    # ---------- roads ----------
    road_lines = {}
    road_buf = {"major": [], "minor": [], "ped": [], "service": [], "path": []}
    walk_cost_geoms = {}
    bridge_bufs = []
    street_names = {}
    for r in F.roads:
        if r["tunnel"]:
            continue
        tier, hw, cost = ROAD_CLASSES[r["cls"]]
        for ls in lines_of(r["line"].intersection(CLIP)):
            road_lines.setdefault(tier, []).append(enc_line(ls.simplify(0.5)))
            buf = ls.buffer(hw, cap_style="flat" if r["bridge"] else "round")
            road_buf[tier].append(buf)
            walk_cost_geoms.setdefault(cost, []).append(buf)
            if r["bridge"]:
                bridge_bufs.append(ls.buffer(hw + 0.5, cap_style="flat"))
            if r["name"] and tier in ("major", "minor", "ped"):
                street_names.setdefault(r["name"], []).append(ls)
    # pedestrian squares: drawn and walked like pedestrian streets
    squares = [g.intersection(CLIP) for g in F.squares]
    road_buf["ped"] += squares
    walk_cost_geoms.setdefault(1.0, []).extend(squares)
    road_polys = {}
    for tier, bufs in road_buf.items():
        if tier in ("service", "path"):  # drawn as lines only
            continue
        u = unary_union(bufs).simplify(0.3)
        road_polys[tier] = [e for p in polys(u) if (e := enc_poly(p))]
    log("roads", {k: len(v) for k, v in road_lines.items()})

    # street labels: one per named street, at midpoint of longest piece
    labels = []
    for name, lss in street_names.items():
        merged = max(lss, key=lambda l: l.length)
        total = sum(l.length for l in lss)
        if total < 120:
            continue
        mid = merged.interpolate(0.5, normalized=True)
        a = merged.interpolate(0.45, normalized=True)
        b = merged.interpolate(0.55, normalized=True)
        ang = float(np.arctan2(b.y - a.y, b.x - a.x))
        labels.append({"name": name, "pos": loc(mid.x, mid.y), "ang": round(ang, 3), "len": round(total)})

    # ---------- water ----------
    water_u = unary_union([c for g in F.water if not (c := g.intersection(CLIP)).is_empty]).simplify(0.5)
    water = [e for p in polys(water_u) if (e := enc_poly(p, 20))]
    waterways = []
    river_obstacles = []
    for cls, line in F.waterways:
        for ls in lines_of(line.intersection(CLIP)):
            waterways.append({"cls": cls, "line": enc_line(ls.simplify(0.5))})
            if cls in ("river", "canal"):
                river_obstacles.append(ls.buffer(4))
    log("water polys", len(water))

    # ---------- parks ----------
    park_u = unary_union([g.intersection(CLIP) for g in F.parks if g.area > 300]).simplify(1.0)
    parks = [e for p in polys(park_u) if (e := enc_poly(p, 300))]

    # ---------- rail ----------
    rail = []
    rail_bufs = []
    for line in F.rail:
        for ls in lines_of(line.intersection(CLIP)):
            rail.append(enc_line(ls.simplify(0.5)))
            rail_bufs.append(ls.buffer(2.5))

    # ---------- point POIs ----------
    pois = []
    for kind, name, pt in F.pois:
        if CLIP.contains(pt):
            pois.append({"kind": kind, "name": name, "pos": loc(pt.x, pt.y)})
    for p in m.places:
        x, y = at(p["at"])
        pois.append({"kind": "place", "name": p["name"], "pos": loc(x, y)})
    log("pois", {k: sum(1 for p in pois if p["kind"] == k) for k in sorted({p["kind"] for p in pois})})

    # ---------- rasters ----------
    W, H = int((MAX_X - MIN_X) / SDF_RES), int((MAX_Y - MIN_Y) / SDF_RES)

    def raster(geoms, res, w, h):
        img = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(img)
        for geom in geoms:
            for p in polys(geom):
                ext = [((x - MIN_X) / res, (MAX_Y - y) / res) for x, y in p.exterior.coords]
                d.polygon(ext, fill=255)
                for r in p.interiors:
                    d.polygon([((x - MIN_X) / res, (MAX_Y - y) / res) for x, y in r.coords], fill=0)
        return np.array(img) > 0  # row 0 = north

    obstacles = [b["poly"] for b in buildings] + [water_u] + river_obstacles
    obst = raster(obstacles, SDF_RES, W, H)
    bridges = raster(bridge_bufs, SDF_RES, W, H)
    obst &= ~bridges
    # signed distance (m): + outside obstacles, - inside
    d_out = ndimage.distance_transform_edt(~obst) * SDF_RES
    d_in = ndimage.distance_transform_edt(obst) * SDF_RES
    sdf = np.where(obst, -d_in + 0.5, d_out - 0.5)
    sdf_i8 = np.flipud(np.clip(np.round(sdf * 10), -127, 127).astype(np.int8))  # row 0 = south

    # cost grid
    CW, CH = int((MAX_X - MIN_X) / COST_RES), int((MAX_Y - MIN_Y) / COST_RES)
    f = int(COST_RES / SDF_RES)
    blocked_frac = obst.reshape(CH, f, CW, f).mean(axis=(1, 3))
    cost = np.full((CH, CW), 2.0)  # open ground (yards, squares)
    cost[raster([park_u], COST_RES, CW, CH)] = 1.5  # parks: crowds spread over grass freely
    for c in sorted(walk_cost_geoms, reverse=True):
        mask = raster(walk_cost_geoms[c], COST_RES, CW, CH)
        cost[mask] = c
    railm = raster(rail_bufs, COST_RES, CW, CH)
    cost[railm] = np.maximum(cost[railm], 6.0)
    near = (sdf.reshape(CH, f, CW, f).min(axis=(1, 3)) < 1.5) & (blocked_frac < 0.6)
    cost[near] += 0.5
    cost_u8 = np.clip(np.round(cost * 10), 1, 254).astype(np.uint8)
    cost_u8[blocked_frac >= 0.6] = 255
    cost_u8 = np.flipud(cost_u8)

    # ---------- CCTV coverage (4 m grid, line of sight against obstacles) ----------
    cctv = np.zeros((CH, CW), dtype=np.uint8)  # row 0 = north (flipped on write)
    for p in pois:
        if p["kind"] != "camera":
            continue
        cx, cy = p["pos"]
        i0, i1 = int((cx - CCTV_R - MIN_X) // COST_RES), int((cx + CCTV_R - MIN_X) // COST_RES) + 1
        j0, j1 = int((MAX_Y - cy - CCTV_R) // COST_RES), int((MAX_Y - cy + CCTV_R) // COST_RES) + 1
        i0, j0, i1, j1 = max(i0, 0), max(j0, 0), min(i1, CW), min(j1, CH)
        ii, jj = np.meshgrid(np.arange(i0, i1), np.arange(j0, j1))
        tx = MIN_X + (ii + 0.5) * COST_RES
        ty = MAX_Y - (jj + 0.5) * COST_RES
        vis = np.hypot(tx - cx, ty - cy) <= CCTV_R
        for t in np.linspace(0.08, 0.95, 24):  # camera sits on a facade: skip its own first metres
            sx = ((cx + (tx - cx) * t - MIN_X) / SDF_RES).astype(int).clip(0, W - 1)
            sy = ((MAX_Y - (cy + (ty - cy) * t)) / SDF_RES).astype(int).clip(0, H - 1)
            vis &= ~obst[sy, sx]
        cctv[jj[vis], ii[vis]] = np.minimum(cctv[jj[vis], ii[vis]].astype(int) + 1, 255)
    cctv = np.flipud(cctv)
    log("cctv covered cells", int((cctv > 0).sum()))

    # ---------- mission route (fastest by car) ----------
    route = []
    if m.route:
        for x, y in routing.fastest(F.car, at(m.route["from"]), at(m.route["to"])):
            p = loc(x, y)
            if MIN_X + 2 < p[0] < MAX_X - 2 and MIN_Y + 2 < p[1] < MAX_Y - 2 and (
                    not route or (p[0] - route[-1][0]) ** 2 + (p[1] - route[-1][1]) ** 2 > 0.25):
                route.append(p)
        if not route:
            log("warning: no car route between route.from and route.to")
    log("route points", len(route))

    # ---------- ring road / trunk carriageways (polylines) ----------
    ring = []
    for r in F.roads:
        if r["cls"] not in ("trunk", "motorway") or r["tunnel"]:
            continue
        for ls in lines_of(r["line"].intersection(CLIP)):
            if ls.length > 20:
                ring.append(enc_line(ls.simplify(1.0)))
    log("ring road pieces", len(ring))

    # ---------- map-edge entry points (where major streets leave the play area) ----------
    edge = CLIP.exterior
    inner = CLIP.buffer(-20)
    entries = []
    for r in F.roads:
        if r["cls"] not in ("primary", "secondary", "tertiary") or r["tunnel"]:
            continue
        if r["line"].intersection(edge).is_empty:
            continue
        for seg in lines_of(r["line"].intersection(inner)):
            for end in (seg.coords[0], seg.coords[-1]):
                if inner.exterior.distance(Point(end)) < 1:
                    e = loc(*end)
                    if all((e[0] - o["pos"][0]) ** 2 + (e[1] - o["pos"][1]) ** 2 > 80 ** 2 for o in entries):
                        entries.append({"name": r["name"], "pos": e})
    log("entries", len(entries))

    # ---------- defendable targets with their evacuation exits ----------
    car_roads = [r["line"] for r in F.roads if r["cls"] in (
        "primary", "secondary", "tertiary", "residential", "service", "unclassified") and not r["tunnel"]]
    targets = {}
    for t in m.targets:
        if t["osm"] not in F.refs:
            log(f"warning: target {t['label']}: {t['osm']} is not in the extract")
            continue
        g = F.refs[t["osm"]][0]
        fp = unary_union([b["poly"] for b in buildings if b["poly"].intersects(g) and (
            g.geom_type == "Point" or b["poly"].intersection(g).area > 0.5 * b["poly"].area)])
        if fp.is_empty:
            log(f"warning: target {t['label']}: no building footprint at {t['osm']}")
            continue
        for b in buildings:
            if b["poly"].within(fp.buffer(0.01)):
                b["kind"], b["name"] = b["kind"] or "gov", t["label"]
        cands = []
        for ls in car_roads:
            if ls.distance(fp) > 30:
                continue
            n = max(2, int(ls.length // 5))
            for k in range(n + 1):
                pt = ls.interpolate(k / n, normalized=True)
                dist = pt.distance(fp)
                if 4 < dist < 30 and CLIP.contains(pt):
                    cands.append((dist, pt.x, pt.y))
        cands.sort()
        exits = []
        for dist, x, y in cands:
            if all((x - ex) ** 2 + (y - ey) ** 2 > 45 ** 2 for ex, ey in exits):
                exits.append((x, y))
            if len(exits) == 3:
                break
        c = fp.centroid
        if all(p["name"] != t["label"] for p in landmarks):  # world.marks finds every target by its label
            landmarks.append({"osm": t["osm"], "kind": "gov", "name": t["label"], "c": c})
        targets[t["label"]] = {"pos": loc(c.x, c.y), "radius": r1(np.sqrt(fp.area / np.pi) + 6),
                               "exits": [loc(x, y) for x, y in exits], "poly": [enc_poly(p) for p in polys(fp)]}
        log("target", t["label"], len(exits), "exits")

    city = {
        "format": FORMAT,
        "crs": m.crs,
        "source": source,
        "cctv": {"file": "cctv.bin", "w": CW, "h": CH, "res": COST_RES, "radius": CCTV_R},
        "route": route,
        "ring": ring,
        "entries": entries,
        "targets": targets,
        "origin": [0, 0],
        "bounds": [MIN_X, MIN_Y, MAX_X, MAX_Y],
        "sdf": {"file": "sdf.bin", "w": W, "h": H, "res": SDF_RES, "scale": 0.1},
        "cost": {"file": "cost.bin", "w": CW, "h": CH, "res": COST_RES, "scale": 0.1},
        "buildings": [{"k": b["kind"], "n": b["name"], "p": enc_poly(b["poly"])} if b["kind"]
                      else {"p": enc_poly(b["poly"])} for b in buildings],
        "roads": road_polys,
        "roadLines": road_lines,
        "water": water,
        "waterways": waterways,
        "parks": parks,
        "rail": rail,
        "pois": pois,
        "landmarks": [{"kind": p["kind"], "name": p["name"], "pos": loc(p["c"].x, p["c"].y), "osm": p["osm"]}
                      for p in landmarks],
        "labels": labels,
    }
    return city, {"sdf.bin": sdf_i8, "cost.bin": cost_u8, "cctv.bin": cctv}, editor_view(m, buildings, landmarks, F, city)


def editor_view(m, buildings, landmarks, F, city):
    """What the map editor (tools/editor) draws over the basemap, in [lon, lat]: buildings with their OSM ids, every
    landmark candidate (used or not), and the built route, entries and targets."""
    inv = Transformer.from_crs(m.crs, "EPSG:4326", always_xy=True)

    def flat(xs, ys):
        lon, lat = inv.transform(np.asarray(xs, float), np.asarray(ys, float))
        return np.round(np.column_stack([lon, lat]), 6).ravel().tolist()

    def ll(x, y):
        return flat([x], [y])

    clip = box(*m.box)
    used = {p["osm"] for p in landmarks}
    cands = []
    for c in F.candidates:
        pt = c["geom"].representative_point() if c["geom"].geom_type != "Point" else c["geom"]
        if clip.contains(pt):
            cands.append({"osm": c["osm"], "kind": c["kind"], "auto": c["auto"], "name": c["name"],
                          "at": ll(pt.x, pt.y), "used": c["osm"] in used})
    return {
        "center": list(m.center),
        "size": list(m.size),
        "source": city["source"],
        "buildings": [{"osm": b["osm"], "k": b["kind"], "n": b["name"], "p": flat(*b["poly"].exterior.xy)}
                      for b in buildings],
        "candidates": cands,
        "route": flat(*zip(*city["route"])) if city["route"] else [],
        "entries": [{"name": e["name"], "at": ll(*e["pos"])} for e in city["entries"]],
        "targets": {k: {"at": ll(*t["pos"]), "exits": [ll(*e) for e in t["exits"]]} for k, t in city["targets"].items()},
    }
