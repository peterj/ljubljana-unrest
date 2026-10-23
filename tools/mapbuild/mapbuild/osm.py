"""Read a clipped extract into the features a map is made of, in local metres. All OSM tagging rules live here."""
from dataclasses import dataclass, field

import numpy as np
import osmium
import shapely
from shapely.geometry import LineString, Point

# highway → (render tier, half width m, walk cost)
ROAD_CLASSES = {
    "motorway": ("major", 8.0, 1.0), "motorway_link": ("major", 4.0, 1.0),
    "trunk": ("major", 6.0, 1.0), "trunk_link": ("major", 4.0, 1.0),
    "primary": ("major", 7.0, 1.0), "primary_link": ("major", 5.0, 1.0),
    "secondary": ("major", 6.0, 1.0), "secondary_link": ("major", 5.0, 1.0),
    "tertiary": ("minor", 5.0, 1.0), "tertiary_link": ("minor", 4.0, 1.0), "residential": ("minor", 4.0, 1.0),
    "unclassified": ("minor", 4.0, 1.0), "living_street": ("ped", 4.0, 1.0),
    "pedestrian": ("ped", 4.0, 1.0), "service": ("service", 2.5, 1.3),
    "footway": ("path", 1.5, 1.2), "path": ("path", 1.2, 1.4),
    "cycleway": ("path", 1.2, 1.3), "steps": ("path", 1.2, 1.8),
    "track": ("path", 1.5, 1.6),
}
# highway → km/h, for the convoy route
CAR_SPEED = {
    "motorway": 90, "motorway_link": 50, "trunk": 70, "trunk_link": 40, "primary": 50, "primary_link": 40,
    "secondary": 45, "secondary_link": 35, "tertiary": 40, "tertiary_link": 30, "residential": 30,
    "unclassified": 30, "living_street": 10, "service": 15,
}
PARK_LANDUSE = {"recreation_ground", "forest", "cemetery", "grass", "meadow"}
WATERWAYS = {"river", "canal", "stream"}
# footways drawn beside or across a street: the street's own buffer already covers them
STREET_FOOTWAYS = {"sidewalk", "crossing", "traffic_island"}
NOT_MAINLINE = {"subway", "light_rail", "monorail", "funicular", "miniature"}
# government=* values that make an office a landmark by itself; other government offices are only suggestions
SEATS = {"legislative", "parliament", "presidency", "prime_minister", "cabinet", "ministry"}
# names: script → Cyrillic letter → Latin, for names that have no name:<lang>-Latn tag
TRANSLIT = {
    "sr": dict(zip("абвгдђежзијклљмнњопрстћуфхцчџшАБВГДЂЕЖЗИЈКЛЉМНЊОПРСТЋУФХЦЧЏШ",
                   "a b v g d đ e ž z i j k l lj m n nj o p r s t ć u f h c č dž š "
                   "A B V G D Đ E Ž Z I J K L Lj M N Nj O P R S T Ć U F H C Č Dž Š".split())),
}


def no(v):
    return v is None or v == "no"


def poi_kind(tags):
    if tags.get("man_made") == "surveillance" and tags.get("surveillance:type", "camera") == "camera":
        return "camera"
    a = tags.get("amenity")
    if a in ("police", "hospital"):
        return a
    if a == "fire_station":
        return "fire"
    if tags.get("highway") == "bus_stop":
        return "bus"
    return None


def landmark_kind(tags):
    """(kind, auto) or None. auto: a landmark without being asked for; otherwise only a suggestion for the editor."""
    a, o, b = tags.get("amenity"), tags.get("office"), tags.get("building")
    if a == "police":
        return "police", True
    if a == "hospital":
        return "hospital", True
    if a in ("townhall", "courthouse") or tags.get("government") in SEATS or b == "parliament":
        return "gov", True
    if (o == "diplomatic" and tags.get("diplomatic", "embassy") == "embassy") or a == "embassy":
        return "embassy", True
    if a == "studio" and tags.get("studio") in ("television", "radio"):
        return "media", True
    if (tags.get("railway") == "station" and tags.get("station") not in NOT_MAINLINE) or (
            tags.get("public_transport") == "station" and tags.get("train") == "yes"):
        return "transit", True
    if b == "cathedral":
        return "landmark", True
    if o == "government" or b == "government":
        return "gov", False
    return None


@dataclass
class Features:
    buildings: list = field(default_factory=list)  # (osm id, polygon)
    roads: list = field(default_factory=list)  # dict(cls, name, bridge, tunnel, line)
    squares: list = field(default_factory=list)  # pedestrian areas (polygons)
    water: list = field(default_factory=list)
    waterways: list = field(default_factory=list)  # (cls, line)
    parks: list = field(default_factory=list)
    rail: list = field(default_factory=list)
    pois: list = field(default_factory=list)  # (kind, name, point)
    candidates: list = field(default_factory=list)  # landmarks by tags: dict(osm, kind, auto, name, geom)
    refs: dict = field(default_factory=dict)  # osm id → (geometry, name), for ids the settings name
    car: list = field(default_factory=list)  # (node ids, xy array, km/h, oneway: 1, -1 or 0)


def referenced_ids(m):
    """OSM ids the settings name explicitly: their geometry is kept whatever their tags."""
    return {t["osm"] for t in m.targets} | {a["osm"] for a in m.landmarks["add"]} | set(m.landmarks["rename"])


def load(pbf, m):
    T = m.to_local()
    wkb = osmium.geom.WKBFactory()
    wanted = referenced_ids(m)
    F = Features()

    letters = TRANSLIT.get(m.transliterate, {})

    def name_of(tags):
        for k in m.names:
            if v := tags.get(k):
                return "".join(letters.get(ch, ch) for ch in v) if letters else v
        return None

    def local(g):
        return shapely.transform(g, lambda c: np.column_stack(T.transform(c[:, 0], c[:, 1])))

    for o in osmium.FileProcessor(str(pbf)).with_areas():
        tags = o.tags
        if not tags:
            continue

        if o.is_node():
            oid = f"node/{o.id}"
            pk, lk = poi_kind(tags), landmark_kind(tags)
            if not (pk or lk or oid in wanted) or not o.location.valid():
                continue
            pt = Point(*T.transform(o.location.lon, o.location.lat))
            name = name_of(tags)
            if pk:
                F.pois.append((pk, name, pt))
            if lk:
                F.candidates.append({"osm": oid, "kind": lk[0], "auto": lk[1], "name": name, "geom": pt})
            if oid in wanted:
                F.refs[oid] = (pt, name)

        elif o.is_way():
            hw, rw, ww = tags.get("highway"), tags.get("railway"), tags.get("waterway")
            road = hw in ROAD_CLASSES and tags.get("area") != "yes" and tags.get("footway") not in STREET_FOOTWAYS
            car = road and hw in CAR_SPEED and tags.get("access") != "no" and no(tags.get("motor_vehicle")) \
                and no(tags.get("motorcar"))
            if not (road or rw == "rail" or ww in WATERWAYS) or len(o.nodes) < 2:
                continue
            try:
                lon = np.array([n.lon for n in o.nodes])
                lat = np.array([n.lat for n in o.nodes])
            except osmium.InvalidLocationError:
                continue
            xy = np.column_stack(T.transform(lon, lat))
            line = LineString(xy)
            tunnel = not no(tags.get("tunnel")) or tags.get("location") == "underground"
            if road:
                F.roads.append({"cls": hw, "name": name_of(tags), "bridge": not no(tags.get("bridge")),
                                "tunnel": tunnel, "line": line})
            if car:
                ow = tags.get("oneway")
                oneway = -1 if ow == "-1" else 1 if ow in ("yes", "1", "true") or (
                    ow is None and (tags.get("junction") in ("roundabout", "circular") or hw.startswith("motorway"))) else 0
                F.car.append((np.array([n.ref for n in o.nodes]), xy, CAR_SPEED[hw], oneway))
            if rw == "rail" and not tunnel:
                F.rail.append(line)
            if ww in WATERWAYS and not tunnel:
                F.waterways.append((ww, line))

        elif o.is_area():
            oid = f"{'way' if o.from_way() else 'relation'}/{o.orig_id()}"
            b, lu, lk = tags.get("building"), tags.get("landuse"), landmark_kind(tags)
            pk = poi_kind(tags)
            is_water = tags.get("natural") == "water" or tags.get("waterway") == "riverbank" or lu == "reservoir"
            is_park = tags.get("leisure") == "park" or lu in PARK_LANDUSE or tags.get("natural") == "wood" \
                or tags.get("amenity") == "grave_yard"
            is_square = (tags.get("highway") == "pedestrian" and (tags.get("area") == "yes" or not o.from_way())) \
                or tags.get("place") == "square"
            is_building = not no(b) and tags.get("location") != "underground"
            if not (is_building or is_water or is_park or is_square or lk or pk in ("police", "hospital", "fire")
                    or oid in wanted):
                continue
            try:
                g = local(shapely.from_wkb(wkb.create_multipolygon(o)))
            except RuntimeError:
                continue
            if not g.is_valid:
                g = shapely.make_valid(g)
            if g.is_empty:
                continue
            name = name_of(tags)
            if is_building:
                F.buildings.append((oid, g))
            if is_water:
                F.water.append(g)
            if is_park:
                F.parks.append(g)
            if is_square:
                F.squares.append(g)
            if lk:
                F.candidates.append({"osm": oid, "kind": lk[0], "auto": lk[1], "name": name, "geom": g})
            if pk in ("police", "hospital", "fire"):
                F.pois.append((pk, name, g.point_on_surface()))
            if oid in wanted:
                F.refs[oid] = (g, name)
    return F
