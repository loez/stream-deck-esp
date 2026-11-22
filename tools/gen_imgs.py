#!/usr/bin/env python3
"""Gera 8 imagens aleatórias (arte procedural, semente fixa) 96x108 em RGB565 -> include/imgs.h e tools/preview.png.
Uso: python3 tools/gen_imgs.py"""
import colorsys, math, os, random
from PIL import Image, ImageDraw, ImageFilter
W, H, SS = 73, 84, 4
HERE = os.path.dirname(os.path.abspath(__file__)); INC = os.path.join(HERE, '..', 'include', 'imgs.h')
def hsv(h, s, v): r, g, b = colorsys.hsv_to_rgb(h % 1, s, v); return int(r * 255), int(g * 255), int(b * 255)
def art(seed):
    rnd = random.Random(seed); h0 = rnd.random(); w, h = W * SS, H * SS
    img = Image.new('RGB', (w, h)); px = img.load()
    c1, c2 = hsv(h0, .75, .95), hsv(h0 + rnd.choice([.12, .5, -.15]), .85, .45)
    ang = rnd.random() * math.pi
    for y in range(h):
        for x in range(w):
            t = ((x / w - .5) * math.cos(ang) + (y / h - .5) * math.sin(ang)) + .5
            t = min(1, max(0, t)); px[x, y] = tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3))
    ov = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    for _ in range(rnd.randint(3, 5)):   # círculos translúcidos ao fundo
        r = rnd.randint(w // 8, w // 2); cx, cy = rnd.randint(0, w), rnd.randint(0, h)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=hsv(h0 + rnd.random() * .3, .5, 1) + (rnd.randint(40, 90),))
    kind = rnd.choice(['star', 'poly', 'rings', 'bars', 'tri'])   # símbolo grande no centro-alto
    cx, cy, R = w // 2, int(h * .40), int(w * .30); white = (255, 255, 255, 235)
    if kind == 'star':
        n = rnd.choice([5, 6, 8]); pts = []
        for i in range(n * 2):
            rr = R if i % 2 == 0 else R * .45; a = math.pi * i / n - math.pi / 2; pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
        d.polygon(pts, fill=white)
    elif kind == 'poly':
        n = rnd.choice([3, 4, 5, 6]); d.polygon([(cx + R * math.cos(2 * math.pi * i / n - math.pi / 2), cy + R * math.sin(2 * math.pi * i / n - math.pi / 2)) for i in range(n)], fill=white)
    elif kind == 'rings':
        for k, f in enumerate([1, .68, .36]): d.ellipse([cx - R * f, cy - R * f, cx + R * f, cy + R * f], outline=white, width=SS * 3 if k < 2 else SS * 5)
        d.ellipse([cx - R * .12, cy - R * .12, cx + R * .12, cy + R * .12], fill=white)
    elif kind == 'bars':
        n = 5; bw = R * 2 // (n * 2 - 1)
        for i in range(n):
            bh = int(R * 2 * rnd.uniform(.35, 1)); x0 = cx - R + i * bw * 2; d.rounded_rectangle([x0, cy + R - bh, x0 + bw, cy + R], radius=bw // 2, fill=white)
    else:
        d.polygon([(cx - R * .7, cy - R), (cx - R * .7, cy + R), (cx + R, cy)], fill=white)
    img = Image.alpha_composite(img.convert('RGBA'), ov).convert('RGB')
    return img.resize((W, H), Image.LANCZOS)
imgs = [art(s) for s in (11, 24, 37, 52, 68, 83, 97, 112)]
out = ['// gerado por tools/gen_imgs.py: 8 imagens %dx%d RGB565 (little-endian)\n#pragma once\n#include <stdint.h>\n#define IMG_W %d\n#define IMG_H %d\n' % (W, H, W, H)]
for i, im in enumerate(imgs):
    b = bytearray()
    for (r, g, bl) in im.getdata():
        v = ((r >> 3) << 11) | ((g >> 2) << 5) | (bl >> 3); b += bytes([v & 255, v >> 8])
    out.append('static const uint8_t img%d[] __attribute__((aligned(4))) = {%s};\n' % (i, ','.join(str(x) for x in b)))
out.append('static const uint8_t *const IMGS[8] = {%s};\n' % ','.join('img%d' % i for i in range(8)))
open(INC, 'w').write(''.join(out))
sheet = Image.new('RGB', (W * 4 + 40, H * 2 + 24), (11, 11, 13))
for i, im in enumerate(imgs): sheet.paste(im, (8 + (i % 4) * (W + 8), 8 + (i // 4) * (H + 8)))
sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST).save(os.path.join(HERE, 'preview.png')); print('ok', INC)
