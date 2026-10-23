import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from mapbuild import config, osm, route


def settings(**over):
    d = {"name": "Test", "center": [20.46, 44.81], "size": [1000, 800]}
    d.update(over)
    folder = Path(tempfile.mkdtemp()) / "testcity"
    folder.mkdir()
    path = folder / "centre.json"
    path.write_text(json.dumps(d))
    return str(path)


class Config(unittest.TestCase):

    def test_loads_and_centres_the_box(self):
        m = config.load(settings(places=[{"name": "Square", "at": [20.461, 44.811]}]))
        self.assertEqual(m.id, "testcity/centre")
        self.assertEqual(m.box, (-500, -400, 500, 400))
        x, y = m.to_local().transform(20.46, 44.81)
        self.assertLess(abs(x) + abs(y), 1e-6)
        lon0, lat0, lon1, lat1 = m.lonlat_box()
        self.assertTrue(lon0 < 20.46 < lon1 and lat0 < 44.81 < lat1)

    def test_rejects_bad_settings(self):
        for bad in ({"size": [1000, 801]}, {"size": [100, 800]}, {"size": [9000, 800]}, {"center": [200, 44]},
                    {"targets": [{"label": "X", "osm": "way:1"}]}, {"transliterate": "xx"},
                    {"landmarks": {"add": [{"kind": "castle", "label": "X", "osm": "way/1"}]}}):
            with self.subTest(bad=bad), self.assertRaises(config.ConfigError):
                config.load(settings(**bad))

    def test_ljubljana_stays_with_build_city(self):
        with self.assertRaises(config.ConfigError):
            config.load("ljubljana/centre")


class Tags(unittest.TestCase):

    def test_landmark_tiers(self):
        self.assertEqual(osm.landmark_kind({"office": "government", "government": "legislative"}), ("gov", True))
        self.assertEqual(osm.landmark_kind({"office": "government", "government": "tax"}), ("gov", False))
        self.assertEqual(osm.landmark_kind({"railway": "station", "station": "subway"}), None)
        self.assertEqual(osm.landmark_kind({"office": "diplomatic", "diplomatic": "consulate"}), None)
        self.assertEqual(osm.poi_kind({"man_made": "surveillance"}), "camera")

    def test_serbian_transliteration(self):
        sr = osm.TRANSLIT["sr"]
        self.assertEqual("".join(sr.get(c, c) for c in "Љубљана, Џорџа Вашингтона"), "Ljubljana, Džordža Vašingtona")


class Route(unittest.TestCase):

    def test_respects_one_way_streets(self):
        # a square 0-1-2-3; 0→1 is one-way the wrong way round, so 0 to 1 goes 0-3-2-1
        xy = {0: (0, 0), 1: (100, 0), 2: (100, 100), 3: (0, 100)}
        way = lambda a, b, oneway: (np.array([a, b]), np.array([xy[a], xy[b]], float), 50, oneway)
        car = [way(1, 0, 1), way(1, 2, 0), way(2, 3, 0), way(3, 0, 0)]
        self.assertEqual(route.fastest(car, (0, 0), (100, 0)), [xy[0], xy[3], xy[2], xy[1]])
        self.assertEqual(route.fastest(car, (100, 0), (0, 0)), [xy[1], xy[0]])


if __name__ == "__main__":
    unittest.main()
