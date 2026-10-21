"""Export the Ljubljana play area from the bloki_si PostGIS database.

Needs a PostGIS database with the tables queried below (OSM layers, GURS footprints, LPP stops, a pgRouting
car network) and Python with shapely, numpy, scipy, PIL and psycopg:

    python tools/build_city.py [area]

The connection comes from the environment: BLOKI_DSN (a libpq connection string), or the standard libpq
variables (PGHOST, PGDATABASE, PGUSER, PGPASSWORD, ~/.pgpass); the database defaults to bloki_si.

area: "centre" (default, public/data/) or another key of AREAS (public/data/<area>/). A mission picks its
data set with `static city = '<area>'`.

Outputs (all coordinates local metres, origin = ORIGIN in EPSG:3794, +x east, +y north):
    public/data/city.json   vector geometry for rendering + POIs + grid metadata
    public/data/sdf.bin     Int8, 1 m cells: signed distance to nearest obstacle (dm, clamped ±12.7 m)
    public/data/cost.bin    Uint8, 4 m cells: traversal cost for flow fields (255 = blocked)
"""
import json
import os
import sys

import numpy as np
import psycopg
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely import wkb
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

DSN = os.environ.get("BLOKI_DSN", "" if "PGDATABASE" in os.environ else "dbname=bloki_si")

# Play areas in EPSG:3794 (D96/TM). Local coordinates are relative to each area's origin.
AREAS = {
    # ~3.2 x 2.9 km around Prešernov trg: every mission unless it names another area
    "centre": {
        "box": (460200, 100000, 463400, 102900), "origin": (461800, 101450),
        "places": [
            ("Prešernov trg", 461771, 101410), ("Kongresni trg", 461640, 101290), ("Trg republike", 461350, 101370),
            ("Tromostovje", 461790, 101375), ("Zmajski most", 462114, 101466), ("Metelkova", 462629, 102015),
            ("Park Tivoli", 460900, 101700), ("Mestni trg", 461880, 101250),
        ],
        # convoy: airport side of Celovška → National Assembly
        "route": ((460860, 102960), (461470, 101480)),
        "targets": ("Državni zbor", "Vlada RS", "Predsedniška palača"),
    },
    # ~2.7 x 3.3 km north-west: Celovška from Tivoli to the northern ring road (H3) and its interchanges
    "north": {
        "box": (459000, 101900, 461700, 105200), "origin": (460350, 103550),
        "places": [
            ("Priključek Celovška", 459865, 104478), ("Priključek Litostrojska", 461010, 104900),
            ("Tržnica Koseze", 459400, 103925), ("Aleja", 460060, 104400), ("Hala Tivoli", 460941, 102360),
            ("Celovška · Tivoli", 461330, 102010), ("Celovška · Šiška", 460700, 103000), ("Stadion ŽAK", 461311, 103452),
        ],
        # Celovška from the Tivoli end up to the ring-road interchange
        "route": ((461330, 102010), (459880, 104440)),
        "targets": (),
    },
}
AREA = sys.argv[1] if len(sys.argv) > 1 else "centre"
A = AREAS[AREA]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data", *(() if AREA == "centre" else (AREA,)))
MIN_X, MIN_Y, MAX_X, MAX_Y = A["box"]
ORIGIN = A["origin"]
SDF_RES = 1.0
COST_RES = 4.0

ENV = f"ST_MakeEnvelope({MIN_X},{MIN_Y},{MAX_X},{MAX_Y},3794)"
CLIP = box(MIN_X, MIN_Y, MAX_X, MAX_Y)

# Road classes → (render tier, half width m, walk cost)
ROAD_CLASSES = {
    "trunk": ("major", 6.0, 1.0), "trunk_link": ("major", 4.0, 1.0),
    "primary": ("major", 7.0, 1.0), "primary_link": ("major", 5.0, 1.0),
    "secondary": ("major", 6.0, 1.0), "secondary_link": ("major", 5.0, 1.0),
    "tertiary": ("minor", 5.0, 1.0), "residential": ("minor", 4.0, 1.0),
    "unclassified": ("minor", 4.0, 1.0), "living_street": ("ped", 4.0, 1.0),
    "pedestrian": ("ped", 4.0, 1.0), "service": ("service", 2.5, 1.3),
    "footway": ("path", 1.5, 1.2), "path": ("path", 1.2, 1.4),
    "cycleway": ("path", 1.2, 1.3), "steps": ("path", 1.2, 1.8),
    "track": ("path", 1.5, 1.6),
}

# Named buildings that matter for gameplay. kind drives colour/bloom in the client.
LANDMARKS = [
    ("gov", "Državni zbor", "Državni zbor Republike Slovenije"),
    ("gov", "Vlada RS", "Vlada Republike Slovenije"),
    ("gov", "Predsedniška palača", "Predsedniška palača"),
    ("gov", "Ministrstvo za zunanje zadeve", "Ministrstvo za zunanje zadeve"),
    ("gov", "Ministrstvo za finance", "Ministrstvo za finance"),
    ("gov", "Kresija", "Kresija"),
    ("media", "RTV Slovenija", "Radiotelevizija Slovenija"),
    ("transit", "Železniška postaja", "Železniška postaja"),
    ("landmark", "Cankarjev dom", "Cankarjev dom"),
    ("landmark", "Nebotičnik", "Nebotičnik"),
    ("landmark", "Stolnica", "Stolnica sv. Nikolaja"),
    ("landmark", "Frančiškanska cerkev", "Frančiškanska cerkev Marijinega oznanjenja"),
]
# POI-polygon landmarks (from osm_pois area rows / points)
POI_LANDMARKS = [
    ("gov", "Magistrat", "town_hall", "Mestna občina Ljubljana"),
    ("gov", "Vrhovno sodišče", "courthouse", "Vrhovno sodišče RS"),
    ("police", "PU Ljubljana", "police", "Policijska uprava Ljubljana"),
    ("police", "PP Ljubljana Center", "police", "Policijska postaja Ljubljana center"),
    ("police", "Policija", "police", None),
    ("hospital", "UKC Ljubljana", "hospital", "Univerzitetni klinični center Ljubljana"),
    ("hospital", "UKC Ljubljana", "hospital", "University Medical Centre Ljubljana"),
    ("hospital", "Urgenca UKC", "hospital", "Urgenca"),
    ("embassy", "Veleposlaništvo ZDA", "embassy", "Veleposlaništvo Združenih držav Amerike"),
    ("embassy", "Veleposlaništvo RF", "embassy", "Veleposlaništvo Ruske federacije"),
    ("embassy", "Veleposlaništvo ZRN", "embassy", "Veleposlaništvo Zvezne republike Nemčije"),
]

PLACES = A["places"]  # gameplay anchors (named open spaces), EPSG:3794


def q(cur, sql):
    cur.execute(sql)
    return cur.fetchall()


def loc(x, y):
    return round(x - ORIGIN[0], 1), round(y - ORIGIN[1], 1)


def ring_coords(ring):
    out = []
    for x, y in list(ring.coords)[:-1]:
        lx, ly = loc(x, y)
        out += [lx, ly]
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
        lx, ly = loc(x, y)
        out += [lx, ly]
    return out


def lines_of(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if g.geom_type == "LineString"]


def main():
    os.makedirs(OUT, exist_ok=True)
    con = psycopg.connect(DSN)
    cur = con.cursor()

    # ---------- buildings (GURS primary footprints) ----------
    rows = q(cur, f"""select building_eid, ST_AsBinary(ST_SimplifyPreserveTopology(geom_3794, 0.4))
                      from gurs_footprints where is_current and geom_3794 && {ENV}""")
    buildings = []
    for eid, g in rows:
        geom = wkb.loads(bytes(g)).intersection(CLIP)
        for p in polys(geom):
            if p.area >= 6:
                buildings.append({"eid": eid, "poly": p, "kind": None, "name": None})
    # GURS misses roughly half the old-town footprints; fill gaps with OSM buildings
    rows = q(cur, f"""select o.osm_id, ST_AsBinary(ST_SimplifyPreserveTopology(o.geom_3794, 0.4))
                      from buildings o where o.is_current and o.geom_3794 && {ENV}
                        and ST_GeometryType(o.geom_3794) in ('ST_Polygon','ST_MultiPolygon')
                        and not exists (select 1 from gurs_footprints g where g.is_current
                                          and g.geom_3794 && o.geom_3794
                                          and ST_Intersects(g.geom_3794, ST_PointOnSurface(o.geom_3794)))""")
    n_gurs = len(buildings)
    for oid, g in rows:
        geom = wkb.loads(bytes(g)).intersection(CLIP)
        for p in polys(geom):
            if p.area >= 6:
                buildings.append({"eid": None, "poly": p, "kind": None, "name": None})
    print("buildings", n_gurs, "gurs +", len(buildings) - n_gurs, "osm")

    from shapely.strtree import STRtree
    tree = STRtree([b["poly"] for b in buildings])

    def tag_by_polygon(target, kind, name):
        hit = 0
        for i in tree.query(target):
            b = buildings[i]
            inter = b["poly"].intersection(target).area
            if inter > 0.5 * b["poly"].area or inter > 0.5 * target.area:
                b["kind"], b["name"] = kind, name
                hit += 1
        return hit

    def tag_by_point(pt, kind, name):
        idx = tree.query_nearest(pt, max_distance=25)
        for i in idx[:1]:
            buildings[i]["kind"], buildings[i]["name"] = kind, name
            return 1
        return 0

    landmarks = []
    for kind, label, osm_name in LANDMARKS:
        rs = q(cur, f"""select ST_AsBinary(geom_3794) from buildings
                        where is_current and geom_3794 && {ENV} and name = '{osm_name}'""")
        for (g,) in rs:
            geom = wkb.loads(bytes(g))
            n = tag_by_polygon(geom, kind, label) if geom.area > 0 else tag_by_point(geom, kind, label)
            c = geom.centroid
            landmarks.append({"kind": kind, "name": label, "pos": loc(c.x, c.y)})
            print("landmark", label, n)

    seen = set()
    for kind, label, fclass, osm_name in POI_LANDMARKS:
        cond = f"name = '{osm_name}'" if osm_name else "name is null"
        rs = q(cur, f"""select osm_id, ST_AsBinary(geom_3794) from osm_pois
                        where is_current and geom_3794 && {ENV} and fclass='{fclass}' and {cond}""")
        for oid, g in rs:
            geom = wkb.loads(bytes(g))
            n = tag_by_polygon(geom, kind, label) if geom.geom_type != "Point" else tag_by_point(geom, kind, label)
            if label in seen and kind == "hospital":
                continue
            seen.add(label)
            c = geom.centroid
            landmarks.append({"kind": kind, "name": label, "pos": loc(c.x, c.y)})
            print("poi landmark", label, n)

    # ---------- roads ----------
    road_rows = q(cur, f"""select fclass, name, bridge, tunnel, ST_AsBinary(geom_3794) from roads
                           where is_current and geom_3794 && {ENV}""")
    road_lines = {}
    road_buf = {"major": [], "minor": [], "ped": [], "service": [], "path": []}
    walk_cost_geoms = {}
    bridge_bufs = []
    street_names = {}
    for fclass, name, bridge, tunnel, g in road_rows:
        if fclass not in ROAD_CLASSES or tunnel == "T":
            continue
        tier, hw, cost = ROAD_CLASSES[fclass]
        geom = wkb.loads(bytes(g)).intersection(CLIP)
        for ls in lines_of(geom):
            road_lines.setdefault(tier, []).append(enc_line(ls.simplify(0.5)))
            buf = ls.buffer(hw, cap_style="flat" if bridge == "T" else "round")
            road_buf[tier].append(buf)
            walk_cost_geoms.setdefault(cost, []).append(buf)
            if bridge == "T":
                bridge_bufs.append(ls.buffer(hw + 0.5, cap_style="flat"))
            if name and tier in ("major", "minor", "ped"):
                street_names.setdefault(name, []).append(ls)
    road_polys = {}
    for tier, bufs in road_buf.items():
        if tier in ("service", "path"):  # drawn as lines only
            continue
        u = unary_union(bufs).simplify(0.3)
        road_polys[tier] = [e for p in polys(u) if (e := enc_poly(p))]
    print("roads", {k: len(v) for k, v in road_lines.items()})

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
    wrows = q(cur, f"""select fclass, name, ST_AsBinary(geom_3794) from osm_water
                       where is_current and geom_3794 && {ENV} and fclass in ('riverbank','water','reservoir')""")
    water_geoms = [wkb.loads(bytes(g)).intersection(CLIP) for _, _, g in wrows]
    water_u = unary_union([g for g in water_geoms if not g.is_empty]).simplify(0.5)
    water = [e for p in polys(water_u) if (e := enc_poly(p, 20))]
    ww = q(cur, f"""select fclass, name, ST_AsBinary(geom_3794) from osm_waterways
                    where is_current and geom_3794 && {ENV} and fclass in ('river','canal','stream')""")
    waterways = []
    river_obstacles = []
    for fclass, name, g in ww:
        geom = wkb.loads(bytes(g)).intersection(CLIP)
        for ls in lines_of(geom):
            waterways.append({"cls": fclass, "line": enc_line(ls.simplify(0.5))})
            if fclass in ("river", "canal"):
                river_obstacles.append(ls.buffer(4))
    print("water polys", len(water))

    # ---------- parks ----------
    prow = q(cur, f"""select fclass, ST_AsBinary(geom_3794) from osm_landuse
                      where is_current and geom_3794 && {ENV}
                        and fclass in ('park','recreation_ground','forest','cemetery','grass','meadow')
                        and ST_Area(geom_3794) > 300""")
    park_u = unary_union([wkb.loads(bytes(g)).intersection(CLIP) for _, g in prow]).simplify(1.0)
    parks = [e for p in polys(park_u) if (e := enc_poly(p, 300))]

    # ---------- rail ----------
    rrows = q(cur, f"""select ST_AsBinary(geom_3794) from osm_railways
                       where is_current and geom_3794 && {ENV} and fclass='rail' and tunnel <> 'T'""")
    rail = []
    rail_bufs = []
    for (g,) in rrows:
        for ls in lines_of(wkb.loads(bytes(g)).intersection(CLIP)):
            rail.append(enc_line(ls.simplify(0.5)))
            rail_bufs.append(ls.buffer(2.5))

    # ---------- point POIs ----------
    pois = []
    for fclass, kind in [("camera_surveillance", "camera"), ("police", "police"), ("hospital", "hospital"),
                         ("fire_station", "fire")]:
        rs = q(cur, f"""select name, ST_X(ST_Centroid(geom_3794)), ST_Y(ST_Centroid(geom_3794)) from osm_pois
                        where is_current and geom_3794 && {ENV} and fclass='{fclass}'""")
        for name, x, y in rs:
            if kind == "hospital" and not (name and ("UKC" in name or "Klini" in name or "Urgenca" in name
                                                     or "University" in name or "Univerzitetni" in name)):
                continue
            pois.append({"kind": kind, "name": name, "pos": loc(x, y)})
    rs = q(cur, f"""select name, ST_X(geom_3794), ST_Y(geom_3794) from transit_stops
                    where is_current and geom_3794 && {ENV}""")
    for name, x, y in rs:
        pois.append({"kind": "bus", "name": name, "pos": loc(x, y)})
    for name, x, y in PLACES:
        pois.append({"kind": "place", "name": name, "pos": loc(x, y)})
    print("pois", {k: sum(1 for p in pois if p["kind"] == k) for k in set(p["kind"] for p in pois)})

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
    sdf_i8 = np.clip(np.round(sdf * 10), -127, 127).astype(np.int8)
    sdf_i8 = np.flipud(sdf_i8)  # row 0 = south, so index = iy*W + ix with y increasing north
    sdf_i8.tofile(os.path.join(OUT, "sdf.bin"))

    # cost grid
    CW, CH = int((MAX_X - MIN_X) / COST_RES), int((MAX_Y - MIN_Y) / COST_RES)
    f = int(COST_RES / SDF_RES)
    blocked_frac = obst.reshape(CH, f, CW, f).mean(axis=(1, 3))
    cost = np.full((CH, CW), 2.0)  # open ground (yards, squares)
    cost[raster([park_u], COST_RES, CW, CH)] = 1.5  # parks: crowds spread over grass freely
    for c in sorted(walk_cost_geoms, reverse=True):
        m = raster(walk_cost_geoms[c], COST_RES, CW, CH)
        cost[m] = c
    railm = raster(rail_bufs, COST_RES, CW, CH)
    cost[railm] = np.maximum(cost[railm], 6.0)
    near = (sdf.reshape(CH, f, CW, f).min(axis=(1, 3)) < 1.5) & (blocked_frac < 0.6)
    cost[near] += 0.5
    cost_u8 = np.clip(np.round(cost * 10), 1, 254).astype(np.uint8)
    cost_u8[blocked_frac >= 0.6] = 255
    np.flipud(cost_u8).tofile(os.path.join(OUT, "cost.bin"))

    # ---------- CCTV coverage (4 m grid, line of sight against obstacles) ----------
    CCTV_R = 35.0
    cctv = np.zeros((CH, CW), dtype=np.uint8)  # row 0 = north (flipped on write)
    cams = [(p["pos"][0] + ORIGIN[0], p["pos"][1] + ORIGIN[1]) for p in pois if p["kind"] == "camera"]
    for cx, cy in cams:
        i0, i1 = int((cx - CCTV_R - MIN_X) // COST_RES), int((cx + CCTV_R - MIN_X) // COST_RES) + 1
        j0, j1 = int((MAX_Y - cy - CCTV_R) // COST_RES), int((MAX_Y - cy + CCTV_R) // COST_RES) + 1
        i0, j0, i1, j1 = max(i0, 0), max(j0, 0), min(i1, CW), min(j1, CH)
        ii, jj = np.meshgrid(np.arange(i0, i1), np.arange(j0, j1))
        tx = MIN_X + (ii + 0.5) * COST_RES
        ty = MAX_Y - (jj + 0.5) * COST_RES
        d = np.hypot(tx - cx, ty - cy)
        vis = d <= CCTV_R
        for t in np.linspace(0.08, 0.95, 24):  # camera sits on a facade: skip its own first metres
            sx = ((cx + (tx - cx) * t - MIN_X) / SDF_RES).astype(int).clip(0, W - 1)
            sy = ((MAX_Y - (cy + (ty - cy) * t)) / SDF_RES).astype(int).clip(0, H - 1)
            vis &= ~obst[sy, sx]
        cctv[jj[vis], ii[vis]] = np.minimum(cctv[jj[vis], ii[vis]].astype(int) + 1, 255)
    np.flipud(cctv).tofile(os.path.join(OUT, "cctv.bin"))
    print("cctv covered cells", int((cctv > 0).sum()))

    # ---------- mission route (pgRouting, car network): the convoy route in the centre, Celovška up north ----------
    (sx, sy), (ex, ey) = A["route"]
    cur.execute(f"""
        with s as (select id from roads_cars_vertices_pgr
                   order by geom <-> ST_Transform(ST_SetSRID(ST_MakePoint({sx}, {sy}), 3794), 4326) limit 1),
             e as (select id from roads_cars_vertices_pgr
                   order by geom <-> ST_Transform(ST_SetSRID(ST_MakePoint({ex}, {ey}), 3794), 4326) limit 1),
             r as (select * from pgr_dijkstra(
                     'select id, source, target, cost, reverse_cost from roads_cars
                       where geometry && ST_MakeEnvelope(14.44, 46.03, 14.55, 46.10, 4326)',
                     (select id from s), (select id from e), true))
        select ST_AsBinary(ST_Transform(case when r.node = c.source then c.geometry else ST_Reverse(c.geometry) end, 3794))
          from r join roads_cars c on c.id = r.edge order by r.seq""")
    route = []
    for (g,) in cur.fetchall():
        for x, y in wkb.loads(bytes(g)).coords:
            p = loc(x, y)
            if not route or (p[0] - route[-1][0]) ** 2 + (p[1] - route[-1][1]) ** 2 > 0.25:
                route.append(p)
    route = [p for p in route if MIN_X - ORIGIN[0] + 2 < p[0] < MAX_X - ORIGIN[0] - 2
             and MIN_Y - ORIGIN[1] + 2 < p[1] < MAX_Y - ORIGIN[1] - 2]
    print("route points", len(route))

    # ---------- ring road / trunk carriageways (polylines; protest objective up north) ----------
    ring = []
    for fclass, name, bridge, tunnel, g in road_rows:
        if fclass != "trunk" or tunnel == "T":
            continue
        for ls in lines_of(wkb.loads(bytes(g)).intersection(CLIP)):
            if ls.length > 20:
                ring.append(enc_line(ls.simplify(1.0)))
    print("ring road pieces", len(ring))

    # ---------- map-edge entry points (where major streets leave the play area) ----------
    edge = CLIP.exterior
    inner = CLIP.buffer(-20)
    entries = []
    for fclass, name, bridge, tunnel, g in road_rows:
        if fclass not in ("primary", "secondary", "tertiary") or tunnel == "T":
            continue
        ls = wkb.loads(bytes(g))
        hit = ls.intersection(edge)
        if hit.is_empty:
            continue
        cut = ls.intersection(inner)
        for seg in lines_of(cut):
            for end in (seg.coords[0], seg.coords[-1]):
                if inner.exterior.distance(Point(end)) < 1:
                    e = loc(*end)
                    if all((e[0] - o["pos"][0]) ** 2 + (e[1] - o["pos"][1]) ** 2 > 80 ** 2 for o in entries):
                        entries.append({"name": name, "pos": e})
    print("entries", len(entries))

    # ---------- defendable targets with their evacuation exits ----------
    car_roads = [wkb.loads(bytes(g)) for fclass, _, _, tunnel, g in road_rows
                 if fclass in ("primary", "secondary", "tertiary", "residential", "service", "unclassified") and tunnel != "T"]
    targets = {}
    for label in A["targets"]:
        fp = unary_union([b["poly"] for b in buildings if b["name"] == label])
        if fp.is_empty:
            continue
        cands = []
        for ls in car_roads:
            if ls.distance(fp) > 30:
                continue
            n = max(2, int(ls.length // 5))
            for k in range(n + 1):
                pt = ls.interpolate(k / n, normalized=True)
                dist = pt.distance(fp)
                if 4 < dist < 30:
                    cands.append((dist, pt.x, pt.y))
        cands.sort()
        exits = []
        for dist, x, y in cands:
            if all((x - ex) ** 2 + (y - ey) ** 2 > 45 ** 2 for ex, ey in exits):
                exits.append((x, y))
            if len(exits) == 3:
                break
        c = fp.centroid
        targets[label] = {"pos": loc(c.x, c.y), "radius": round(float(np.sqrt(fp.area / np.pi)) + 6, 1),
                          "exits": [loc(x, y) for x, y in exits], "poly": [enc_poly(p) for p in polys(fp)]}
        print("target", label, len(exits), "exits")

    city = {
        "srid": 3794,
        "cctv": {"file": "cctv.bin", "w": CW, "h": CH, "res": COST_RES, "radius": CCTV_R},
        "route": route,
        "ring": ring,
        "entries": entries,
        "targets": targets,
        "origin": ORIGIN,
        "bounds": [MIN_X - ORIGIN[0], MIN_Y - ORIGIN[1], MAX_X - ORIGIN[0], MAX_Y - ORIGIN[1]],
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
        "landmarks": landmarks,
        "labels": labels,
    }
    with open(os.path.join(OUT, "city.json"), "w") as fh:
        json.dump(city, fh, ensure_ascii=False, separators=(",", ":"))
    print("done", os.path.getsize(os.path.join(OUT, "city.json")) // 1024, "KB")


if __name__ == "__main__":
    main()
