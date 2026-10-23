"""Share image (Open Graph / Twitter card): public/og-image.png, 1200 × 630.

The real map around Kongresni trg in the game's palette with a moment from "Clash": the march on Prešernov trg and
Čopova, the counter-protest on Kongresni trg, police cordons between them. Glowing things are drawn on a separate
layer, blurred and added back (the game's bloom).

    python3 tools/og_image.py <dir with IBMPlexMono-Bold.ttf, -SemiBold.ttf, -Regular.ttf>

Needs numpy + Pillow. Reads public/data/city.json and sdf.bin; writes public/og-image.png.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'tools' / 'fonts'
W, H = 1200, 630
SS = 2  # supersampling
X0, X1 = -500, 110  # local metres shown (Slovenska → Prešernov trg and the river)
Y_MID = -85
S = W / (X1 - X0)
rng = np.random.default_rng(7)

city = json.loads((ROOT / 'public/data/city.json').read_text())
sd = city['sdf']
sdf = np.fromfile(ROOT / 'public/data' / sd['file'], dtype=np.int8).reshape(sd['h'], sd['w'])
bx0, by0 = city['bounds'][0], city['bounds'][1]


def clear(x, y):
    return sdf[int(y - by0), int(x - bx0)] * 0.1


def px(x, y):
    return ((x - X0) * S * SS, (H / 2 - (y - Y_MID) * S) * SS)


def pts(flat):
    return [px(flat[k], flat[k + 1]) for k in range(0, len(flat) - 1, 2)]


def rgb(h, a=255):
    return ((h >> 16) & 255, (h >> 8) & 255, h & 255, a)


base = Image.new('RGBA', (W * SS, H * SS), rgb(0x05070b))
glow = Image.new('RGBA', (W * SS, H * SS), (0, 0, 0, 255))
d, g = ImageDraw.Draw(base), ImageDraw.Draw(glow)

# ---- city
for p in city['parks']:
    for ring in p:
        if len(ring) >= 6:
            d.polygon(pts(ring), fill=rgb(0x0b1611), outline=rgb(0x16291f))
for ring in city['water']:
    if len(ring) >= 6:
        d.polygon(pts(ring), fill=rgb(0x081826))
for w in city['waterways']:
    d.line(pts(w['line']), fill=rgb(0x1d5d8c), width=2 * SS)
for kind, polys in city['roads'].items():  # road surfaces (polygons, first ring outer)
    col = {'major': 0x1a1f28, 'minor': 0x14181f}.get(kind, 0x1f1a15)
    for poly in polys:
        if len(poly[0]) >= 6:
            d.polygon(pts(poly[0]), fill=rgb(col))
        for hole in poly[1:]:
            if len(hole) >= 6:
                d.polygon(pts(hole), fill=rgb(0x05070b))
for b in city['buildings']:
    for ring in b['p']:
        if len(ring) >= 6:
            d.polygon(pts(ring), fill=rgb(0x0f1218), outline=rgb(0x262d39))

# landmarks: the Assembly glows orange, police stations blue
for lm in city['landmarks']:
    col = {'gov': 0xff6a10, 'police': 0x2b8cff}.get(lm['kind'])
    if not col:
        continue
    x, y = px(*lm['pos'])
    for b in city['buildings']:
        ring = b['p'][0]
        if abs(ring[0] - lm['pos'][0]) < 40 and abs(ring[1] - lm['pos'][1]) < 40:
            xs, ys = ring[0::2], ring[1::2]
            if min(xs) - 2 <= lm['pos'][0] <= max(xs) + 2 and min(ys) - 2 <= lm['pos'][1] <= max(ys) + 2:
                d.polygon(pts(ring), fill=rgb(0x2b1206 if lm['kind'] == 'gov' else 0x06162b))
                g.line(pts(ring + ring[:2]), fill=rgb(col), width=2 * SS)


# ---- people
def scatter(n, cx, cy, sx, sy=None):
    out = []
    while len(out) < n:
        x, y = rng.normal(cx, sx), rng.normal(cy, sy or sx)
        if clear(x, y) > 0.4:
            out.append((x, y))
    return out


def along(path, n, spread):
    seg = [(path[k], path[k + 1]) for k in range(len(path) - 1)]
    lens = [math.dist(a, b) for a, b in seg]
    out = []
    while len(out) < n:
        t = rng.uniform(0, sum(lens))
        for (a, b), L in zip(seg, lens):
            if t <= L:
                f = t / L
                x, y = a[0] + (b[0] - a[0]) * f + rng.normal(0, spread), a[1] + (b[1] - a[1]) * f + rng.normal(0, spread)
                if clear(x, y) > 0.4:
                    out.append((x, y))
                break
            t -= L
    return out


def dots(points, col, hot, r=0.65, hot_share=0.25):
    for x, y in points:
        cx, cy = px(x, y)
        rr = r * S * SS
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=rgb(col))
        if rng.random() < hot_share:
            g.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=rgb(hot))


march = scatter(1500, -35, -38, 20, 16) + along([(-63, -12), (-141, 26), (-214, 60), (-260, 86), (-314, 102)], 1100, 3.5)
counter = scatter(900, -165, -160, 28, 22) + scatter(250, -230, -170, 16)
bystanders = scatter(500, -250, -40, 160, 120)
dots(bystanders, 0x77756f, 0x000000, r=0.45, hot_share=0)
dots(march, 0xd8641a, 0xffa060)
dots(counter, 0x9ad62a, 0xd8ff6a, hot_share=0.35)

# police cordons (the Clash opening lines), 3 deep
for a, b, n in [((-80, -109), (-89, -104), 3), ((-59, -112), (-64, -109), 1), ((-193, -96), (-183, -95), 1),
                ((-286, -86), (-252, -86), 3), ((-309, -107), (-302, -83), 2)]:
    L = math.dist(a, b)
    dx, dy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    count = n * 24
    rows = max(1, min(4, math.ceil(count * 0.75 / L)))
    per = math.ceil(count / rows)
    for k in range(count):
        col, row = k // rows, k % rows
        t = (col / (per - 1) - 0.5) * L if per > 1 else 0
        x = (a[0] + b[0]) / 2 + dx * t + dy * row * 0.8
        y = (a[1] + b[1]) / 2 + dy * t - dx * row * 0.8
        cx, cy = px(x, y)
        rr = 0.7 * S * SS
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=rgb(0x2b8cff))
        g.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=rgb(0x1a5cc0))

# a patrol car behind the Slovenska line, beacon glow
cx, cy = px(-251, -45)
g.ellipse((cx - 14 * SS, cy - 14 * SS, cx + 14 * SS, cy + 14 * SS), fill=rgb(0x173a6e))
d.rectangle((cx - 2 * SS, cy - 5 * SS, cx + 2 * SS, cy + 5 * SS), fill=rgb(0x0d2244), outline=rgb(0x2b8cff))

# ---- compose: bloom = blurred glow added twice (wide + tight)
glow_s = glow.resize((W, H), Image.LANCZOS)
img = base.resize((W, H), Image.LANCZOS).convert('RGB')
for radius, k in [(9, 0.9), (2.5, 1.0)]:
    bl = glow_s.filter(ImageFilter.GaussianBlur(radius)).convert('RGB')
    bl = Image.eval(bl, lambda v: min(255, int(v * k * 1.6)))
    img = ImageChops.add(img, bl)
img = ImageChops.add(img, glow_s.convert('RGB'))

# left-hand shade for the title
shade = np.zeros((H, W), dtype=np.uint8)
xs = np.arange(W)
shade[:] = np.clip(235 * (1 - (xs - 380) / 300), 0, 235).astype(np.uint8)
img = Image.composite(Image.new('RGB', (W, H), (5, 7, 11)), img, Image.fromarray(shade))
vig = Image.new('L', (W, H), 0)
ImageDraw.Draw(vig).rectangle((0, H - 6, W, H), fill=255)
img = Image.composite(Image.new('RGB', (W, H), (255, 106, 16)), img, vig)

# ---- text
t = ImageDraw.Draw(img)
bold = ImageFont.truetype(str(FONTS / 'IBMPlexMono-Bold.ttf'), 66)
semi = ImageFont.truetype(str(FONTS / 'IBMPlexMono-SemiBold.ttf'), 25)
reg = ImageFont.truetype(str(FONTS / 'IBMPlexMono-Regular.ttf'), 19)
t.text((64, 196), 'CORDON', font=bold, fill=(255, 106, 16))
t.text((64, 266), 'BLEU', font=bold, fill=(43, 140, 255))
t.text((66, 360), 'Command the police.', font=semi, fill=(233, 228, 216))
t.text((66, 394), 'Or lead the protest.', font=semi, fill=(233, 228, 216))
t.text((66, 456), 'A crowd strategy game on the', font=reg, fill=(124, 130, 144))
t.text((66, 482), 'streets of real cities.', font=reg, fill=(124, 130, 144))
# legend: a colour square, then the word (Plex Mono has no ■)
x = 66
for word, col in [('protest', (255, 106, 16)), ('police', (43, 140, 255)), ('counter-protest', (154, 214, 42))]:
    t.rectangle((x, 549, x + 11, 560), fill=col)
    t.text((x + 19, 542), word, font=reg, fill=(124, 130, 144))
    x += 19 + t.textlength(word, font=reg) + 26

small = ImageFont.truetype(str(FONTS / 'IBMPlexMono-Regular.ttf'), 15)
note = '© 2026 Virostatiq'
t.text((66, H - 44), note, font=small, fill=(124, 130, 144))

out = ROOT / 'public' / 'og-image.png'
img.save(out, optimize=True)
print(out, img.size, out.stat().st_size // 1024, 'kB')
