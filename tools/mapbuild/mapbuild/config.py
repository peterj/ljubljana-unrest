"""Map settings: maps/<city>/<area>.json (the format is described in maps/README.md).

The local coordinates are a transverse Mercator projection centred on `center` (metres, +x east, +y north),
so the origin is (0, 0).
"""
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from pyproj import Transformer

from .osm import TRANSLIT

ROOT = Path(__file__).resolve().parents[3]
MAPS = ROOT / "maps"
MAX_SIDE = 8192  # the SDF is a 1 m texture: GPUs cap 2D textures at 8192 texels per side
KINDS = ("gov", "media", "transit", "landmark", "police", "hospital", "embassy")
OSM_ID = re.compile(r"^(node|way|relation)/\d+$")
ID = re.compile(r"^[a-z0-9_-]+$")


class ConfigError(Exception):
    pass


@dataclass
class Map:
    city: str
    area: str
    name: str
    center: tuple
    size: tuple
    names: list = field(default_factory=lambda: ["name"])
    transliterate: str | None = None
    places: list = field(default_factory=list)
    route: dict | None = None
    targets: list = field(default_factory=list)
    landmarks: dict = field(default_factory=dict)
    source: Path | None = None

    @property
    def id(self):
        return f"{self.city}/{self.area}"

    @property
    def crs(self):
        lon, lat = self.center
        return f"+proj=tmerc +lat_0={lat} +lon_0={lon} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"

    @property
    def box(self):
        w, h = self.size
        return (-w / 2, -h / 2, w / 2, h / 2)

    def to_local(self):
        return Transformer.from_crs("EPSG:4326", self.crs, always_xy=True)

    def lonlat_box(self, margin=0.0):
        """(min_lon, min_lat, max_lon, max_lat) around the play area grown by margin metres."""
        x0, y0, x1, y1 = self.box
        t = Transformer.from_crs(self.crs, "EPSG:4326", always_xy=True)
        xs, ys = t.transform([x0 - margin, x1 + margin, x1 + margin, x0 - margin, 0, 0],
                             [y0 - margin, y0 - margin, y1 + margin, y1 + margin, y0 - margin, y1 + margin])
        return min(xs), min(ys), max(xs), max(ys)


def _lonlat(v, where):
    if not (isinstance(v, list) and len(v) == 2 and all(isinstance(c, (int, float)) for c in v)
            and -180 <= v[0] <= 180 and -90 <= v[1] <= 90):
        raise ConfigError(f"{where} must be [lon, lat]")
    return tuple(v)


def _osm(v, where):
    if not (isinstance(v, str) and OSM_ID.match(v)):
        raise ConfigError(f"{where} must be an OSM id like way/123, node/45 or relation/6")
    return v


def load(spec):
    """spec: "<city>/<area>" (maps/<city>/<area>.json) or a path to a settings file."""
    if spec.endswith(".json"):
        path = Path(spec).resolve()
        city, area = path.parent.name, path.stem
    else:
        city, _, area = spec.partition("/")
        path = MAPS / city / f"{area}.json"
    if not (ID.match(city) and ID.match(area)):
        raise ConfigError(f"{spec}: city and area must be lower-case folder names")
    if city == "ljubljana":
        raise ConfigError("the Ljubljana maps are built from PostGIS by tools/build_city.py")
    if not path.exists():
        raise ConfigError(f"{path} does not exist")
    d = json.loads(path.read_text())

    for k in ("name", "center", "size"):
        if k not in d:
            raise ConfigError(f"{path.name}: {k} is required")
    size = d["size"]
    if not (isinstance(size, list) and len(size) == 2 and all(isinstance(s, (int, float)) and 200 <= s <= MAX_SIDE
                                                              for s in size)):
        raise ConfigError(f"size must be [width, height] in metres, 200 to {MAX_SIDE}")
    if any(s % 4 for s in size):
        raise ConfigError("size must be a multiple of 4 m (the cost grid)")
    m = Map(city=city, area=area, name=str(d["name"]), center=_lonlat(d["center"], "center"),
            size=tuple(int(s) for s in size), source=path)
    m.names = d.get("names", ["name"])
    if not (isinstance(m.names, list) and m.names and all(isinstance(n, str) for n in m.names)):
        raise ConfigError("names must be a list of tag keys")
    m.transliterate = d.get("transliterate")
    if m.transliterate is not None and m.transliterate not in TRANSLIT:
        raise ConfigError(f"transliterate must be one of {', '.join(TRANSLIT)}")
    for i, p in enumerate(d.get("places", [])):
        m.places.append({"name": str(p["name"]), "at": _lonlat(p.get("at"), f"places[{i}].at")})
    if d.get("route"):
        m.route = {k: _lonlat(d["route"].get(k), f"route.{k}") for k in ("from", "to")}
    for i, t in enumerate(d.get("targets", [])):
        m.targets.append({"label": str(t["label"]), "osm": _osm(t.get("osm"), f"targets[{i}].osm")})
    lm = d.get("landmarks", {})
    add = []
    for i, a in enumerate(lm.get("add", [])):
        if a.get("kind") not in KINDS:
            raise ConfigError(f"landmarks.add[{i}].kind must be one of {', '.join(KINDS)}")
        add.append({"kind": a["kind"], "label": str(a["label"]), "osm": _osm(a.get("osm"), f"landmarks.add[{i}].osm")})
    m.landmarks = {
        "auto": bool(lm.get("auto", True)),
        "add": add,
        "drop": {_osm(v, "landmarks.drop[]") for v in lm.get("drop", [])},
        "rename": {_osm(k, "landmarks.rename key"): str(v) for k, v in lm.get("rename", {}).items()},
    }
    return m

