// Imagem do botão (73x84): imagem própria (recortada) ou símbolo/ícone de app sobre um degradê. O nome é desenhado pela placa (faixa de 32 px no rodapé).
// Equivalente ao render() do servidor Python, com o canvas do Skia no lugar do Pillow. Texto: paridade exata; imagens: paridade perceptual (ver test/parity.ts).
import { lastResources, resVer } from './resources.ts';
import { notifCanvas } from './notify.ts';
import { isAbsolute, levelOf, sliderAxis, sliderColor } from './slider.ts';
import { widgetCanvas } from './widgets.ts';
import { stateOf, stateTag } from './state.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts, ImageData } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import type { Canvas, Image, SKRSContext2D } from '@napi-rs/canvas';
import type { Store, Action } from './config.ts';
import { UPLOADS, DEFAULT_NAMES } from './env.ts';
import { appPath, appPathByBundle, appIconFile } from './apps.ts';
import { FONT_PATH, labelFit, displayLabel, textWidth, metrics } from './fit.ts';
import { hooks } from './hooks.ts';
import { hexRgb } from './util.ts';
import { pilResize, pilFit, fitInside } from './resample.ts';
import type { Raster } from './resample.ts';

GlobalFonts.registerFromPath(FONT_PATH, 'MontserratDeck');
type Src = Canvas | Image;
type RGB = [number, number, number];

// ---------- conversões entre canvas e pixels crus ----------
const toRaster = (cv: Canvas): Raster => ({ w: cv.width, h: cv.height, data: new Uint8ClampedArray(cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data) });
function toCanvas(r: Raster): Canvas { const cv = createCanvas(r.w, r.h); cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0); return cv; }

// ---------- cor dominante do ícone (colorsys do Python) ----------
function rgbToHsv(r: number, g: number, b: number): RGB {
  const maxc = Math.max(r, g, b), minc = Math.min(r, g, b), v = maxc;
  if (minc === maxc) return [0, 0, v];
  const s = (maxc - minc) / maxc, rc = (maxc - r) / (maxc - minc), gc = (maxc - g) / (maxc - minc), bc = (maxc - b) / (maxc - minc);
  let h = r === maxc ? bc - gc : g === maxc ? 2 + rc - bc : 4 + gc - rc;
  h = (((h / 6) % 1) + 1) % 1;
  return [h, s, v];
}
function hsvToRgb(h: number, s: number, v: number): RGB {
  if (s === 0) return [v, v, v];
  let i = Math.trunc(h * 6); const f = h * 6 - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  i %= 6;
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i] as RGB;
}
function dominant(icon: Raster): RGB {
  const d = pilResize(icon, 24, 24, 'bicubic', true).data;   // icon.resize((24, 24)) do Pillow (bicúbico)
  const hsv: RGB[] = [];
  for (let k = 0; k < d.length; k += 4) if (d[k + 3]! > 200) hsv.push(rgbToHsv(d[k]! / 255, d[k + 1]! / 255, d[k + 2]! / 255));
  if (!hsv.length) return [60, 64, 80];
  const hs = hsv.sort((a, b) => -a[1] * a[2] - -b[1] * b[2]).slice(0, Math.max(1, Math.floor(hsv.length / 4)));   // sort estável como o sorted() do Python
  const h = ((Math.atan2(hs.reduce((a, t) => a + Math.sin(2 * Math.PI * t[0]), 0), hs.reduce((a, t) => a + Math.cos(2 * Math.PI * t[0]), 0)) / (2 * Math.PI)) % 1 + 1) % 1;
  const s = Math.min(1, Math.max(0.35, hs.reduce((a, t) => a + t[1], 0) / hs.length)), v = Math.max(0.55, hs.reduce((a, t) => a + t[2], 0) / hs.length);
  return hsvToRgb(h, s, v).map((c) => Math.trunc(c * 255)) as RGB;
}

// ---------- símbolos (RGBA branco 176x176) ----------
const PAGE_COLORS: Record<string, RGB> = { up: [112, 104, 160], next: [62, 99, 176], prev: [62, 99, 176], home: [52, 140, 104], back: [112, 104, 160], goto: [196, 128, 40] };
const NEW_COLORS: Record<string, RGB> = { folder: [38, 132, 148], quitapp: [196, 64, 72], url: [45, 120, 190], text: [150, 90, 170], hotkey: [88, 98, 112], media: [200, 64, 96], multi: [224, 150, 40], webhook: [112, 84, 200], homeassistant: [24, 150, 205], mqtt: [96, 70, 150] };
const KEYCAP: Record<string, string> = { return: 'Ret', enter: 'Ret', space: 'Spc', delete: 'Del', backspace: 'Del', forwarddelete: 'Fwd', escape: 'Esc', left: '<', right: '>', up: '^', down: 'v', pageup: 'PgU', pagedown: 'PgD' };

type Pt = [number, number];
const poly = (c: SKRSContext2D, pts: Pt[]) => { c.beginPath(); pts.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill(); };
const line = (c: SKRSContext2D, pts: Pt[], width: number, round = false) => { c.lineWidth = width; c.lineJoin = round ? 'round' : 'miter'; c.lineCap = 'butt'; c.beginPath(); pts.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke(); };
const rect = (c: SKRSContext2D, x0: number, y0: number, x1: number, y1: number) => c.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);   // Pillow: coordenadas finais inclusivas
const rrect = (c: SKRSContext2D, x0: number, y0: number, x1: number, y1: number, r: number, stroke = 0) => {
  c.beginPath();
  if (stroke) { const h = stroke / 2; c.roundRect(x0 + h, y0 + h, x1 - x0 + 1 - stroke, y1 - y0 + 1 - stroke, Math.max(0, r - h)); c.lineWidth = stroke; c.stroke(); }
  else { c.roundRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1, r); c.fill(); }
};
const ellipse = (c: SKRSContext2D, x0: number, y0: number, x1: number, y1: number, stroke = 0) => {
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2, rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2;
  c.beginPath();
  if (stroke) { c.ellipse(cx, cy, rx - stroke / 2, ry - stroke / 2, 0, 0, Math.PI * 2); c.lineWidth = stroke; c.stroke(); } else { c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); c.fill(); }
};
const arc = (c: SKRSContext2D, x0: number, y0: number, x1: number, y1: number, a0: number, a1: number, stroke: number) => {
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2, rx = (x1 - x0 + 1) / 2 - stroke / 2, ry = (y1 - y0 + 1) / 2 - stroke / 2, r = Math.PI / 180;
  c.beginPath(); c.ellipse(cx, cy, rx, ry, 0, a0 * r, a1 * r); c.lineWidth = stroke; c.lineCap = 'butt'; c.stroke();
};

function glyphCanvas(draw: (c: SKRSContext2D) => void, mirror = false): Canvas {
  const cv = createCanvas(176, 176), c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.strokeStyle = '#fff';
  if (mirror) { c.translate(176, 0); c.scale(-1, 1); }
  draw(c); return cv;
}
/** Centraliza o texto como o Pillow: a caixa vai do topo da tinta até a linha de base (e do bearing/0 até o avanço) — não até o fundo da tinta. */
function centerText(c: SKRSContext2D, txt: string, px: number) {
  c.font = `${px}px MontserratDeck`; c.textBaseline = 'alphabetic';
  const m = c.measureText(txt), asc = metrics(px)[0];
  const bb0 = Math.min(0, Math.floor(-m.actualBoundingBoxLeft)), bb2 = Math.max(textWidth(txt, px), Math.ceil(m.actualBoundingBoxRight));
  const bb1 = asc - Math.ceil(m.actualBoundingBoxAscent), bb3 = Math.max(asc, asc + Math.ceil(m.actualBoundingBoxDescent));
  c.fillText(txt, 88 - (bb0 + bb2) / 2, 88 - (bb1 + bb3) / 2 + asc);
}

function pageGlyph(op: string): Canvas {
  if (op === 'next' || op === 'prev') return glyphCanvas((c) => { line(c, [[24, 88], [112, 88]], 22); poly(c, [[100, 36], [156, 88], [100, 140]]); }, op === 'prev');
  if (op === 'home') return glyphCanvas((c) => { poly(c, [[88, 18], [14, 84], [162, 84]]); rect(c, 36, 80, 140, 152); c.globalCompositeOperation = 'destination-out'; rect(c, 74, 108, 102, 152); });
  if (op === 'back' || op === 'up') return glyphCanvas((c) => { line(c, [[150, 148], [150, 78], [66, 78]], 22, true); poly(c, [[72, 36], [72, 120], [18, 78]]); });
  return glyphCanvas((c) => { rrect(c, 20, 38, 96, 80, 10); rrect(c, 20, 58, 156, 140, 14); });   // goto: pasta
}

/** [ícone branco, cor de fundo padrão] para ações que não são um app. */
function actionGlyph(act: Action): [Canvas, RGB] {
  const t = act.type;
  if (t === 'page') return [pageGlyph(act.op as string), PAGE_COLORS[act.op as string]!];
  if (t === 'folder') return [pageGlyph('goto'), NEW_COLORS.folder!];   // pasta
  const cv = glyphCanvas((c) => {
    if (t === 'quitapp') { ellipse(c, 22, 22, 154, 154, 14); line(c, [[62, 62], [114, 114]], 16); line(c, [[114, 62], [62, 114]], 16); }
    else if (t === 'url') { ellipse(c, 18, 18, 158, 158, 13); ellipse(c, 62, 18, 114, 158, 11); line(c, [[18, 88], [158, 88]], 11); }
    else if (t === 'text') centerText(c, 'Aa', 96);
    else if (t === 'hotkey') {
      const key = String(act.keys || '').split('+').pop()!.trim().toLowerCase(); rrect(c, 16, 16, 160, 160, 30, 12);
      const cap = KEYCAP[key] ?? key.toUpperCase(); centerText(c, cap, cap.length === 1 ? 84 : cap.length === 2 ? 56 : 44);
    } else if (t === 'multi') {
      const mode = act.mode ?? 'seq';
      if (mode === 'par') for (const y of [34, 88, 142]) { line(c, [[16, y], [112, y]], 14); poly(c, [[100, y - 22], [160, y], [100, y + 22]]); }
      else if (mode === 'cycle') { arc(c, 26, 26, 150, 150, 200, 340, 16); poly(c, [[152, 70], [118, 70], [138, 100]]); arc(c, 26, 26, 150, 150, 20, 160, 16); poly(c, [[24, 106], [58, 106], [38, 76]]); }
      else if (mode === 'random') { rrect(c, 20, 20, 156, 156, 26, 13); for (const [x, y] of [[58, 58], [118, 58], [88, 88], [58, 118], [118, 118]] as Pt[]) ellipse(c, x - 11, y - 11, x + 11, y + 11); }
      else poly(c, [[104, 10], [34, 100], [82, 100], [64, 166], [142, 70], [94, 70]]);
    } else if (t === 'homeassistant') {   // casa
      poly(c, [[88, 14], [168, 84], [148, 84], [148, 162], [28, 162], [28, 84], [8, 84]]); c.globalCompositeOperation = 'destination-out'; rect(c, 72, 112, 104, 162); c.globalCompositeOperation = 'source-over';
    } else if (t === 'webhook') {   // gancho / elo de rede: três nós ligados
      line(c, [[48, 128], [88, 56], [128, 128]], 12); line(c, [[48, 128], [128, 128]], 12); ellipse(c, 24, 104, 72, 152); ellipse(c, 64, 32, 112, 80); ellipse(c, 104, 104, 152, 152);
    } else if (t === 'mqtt') {   // transmissão: ponto com ondas
      ellipse(c, 70, 70, 106, 106); arc(c, 40, 40, 136, 136, -50, 50, 12); arc(c, 14, 14, 162, 162, -50, 50, 12); arc(c, 40, 40, 136, 136, 130, 230, 12); arc(c, 14, 14, 162, 162, 130, 230, 12);
    } else if (t === 'media') {
      const k = act.key as string, spk: Pt[] = [[14, 68], [46, 68], [88, 32], [88, 144], [46, 108], [14, 108]];
      if (k === 'playpause') { poly(c, [[12, 28], [12, 148], [84, 88]]); rect(c, 102, 28, 126, 148); rect(c, 140, 28, 164, 148); }
      else if (k === 'next') { poly(c, [[28, 28], [28, 148], [116, 88]]); rect(c, 128, 28, 152, 148); }
      else if (k === 'prev') { poly(c, [[148, 28], [148, 148], [60, 88]]); rect(c, 24, 28, 48, 148); }
      else if (k === 'volup' || k === 'voldown' || k === 'mute') {
        poly(c, spk);
        if (k === 'mute') { line(c, [[112, 66], [160, 110]], 14); line(c, [[160, 66], [112, 110]], 14); }
        else { arc(c, 66, 54, 130, 122, -50, 50, 12); if (k === 'volup') arc(c, 48, 30, 152, 146, -50, 50, 12); }
      } else {   // brilho: sol
        ellipse(c, 58, 58, 118, 118);
        for (let ang = 0; ang < 360; ang += 45) { const cs = Math.cos((ang * Math.PI) / 180), sn = Math.sin((ang * Math.PI) / 180); line(c, [[88 + 44 * cs, 88 + 44 * sn], [88 + 72 * cs, 88 + 72 * sn]], 10); }
        if (k === 'brightdown') rect(c, 40, 150, 136, 162);
      }
    }
  });
  return [cv, NEW_COLORS[t]!];
}

// ---------- o botão ----------
/** Decodifica a imagem com os valores CRUS dos pixels, ignorando o perfil de cor embutido (como o Pillow). Os ícones do macOS vêm em Display P3:
 *  o Skia os converteria para sRGB (cores mais saturadas) e o fundo/símbolos divergiriam do servidor Python, já validado visualmente na placa. */
async function decodeRaw(buf: Buffer): Promise<Raster> {
  if (buf.length > 33 && buf.readUInt32BE(0) === 0x89504e47) {
    const deep = buf[24] === 16;   // profundidade de bits no IHDR. 16 bits: o Pillow fica com o BYTE ALTO (v >> 8), então lemos os 16 bits crus
    const png = PNG.sync.read(buf, deep ? { skipRescale: true } : {}), src = png.data as unknown as ArrayLike<number>, px = new Uint8ClampedArray(png.width * png.height * 4);
    for (let k = 0; k < px.length; k++) px[k] = deep ? src[k]! >> 8 : src[k]!;
    return { w: png.width, h: png.height, data: px };
  }
  const im = await loadImage(buf), cv = createCanvas(im.width, im.height); cv.getContext('2d').drawImage(im, 0, 0); return toRaster(cv);   // JPEG/WebP/GIF: o Skia decodifica
}
export const decodeImageBuffer = (buf: Buffer): Promise<Raster> => decodeRaw(buf);   // para o host de plugins (valores crus, como o Pillow)
const imgCache = new Map<string, Raster>();
async function load(file: string): Promise<Raster | null> {
  try { const st = fs.statSync(file); const key = file + ':' + st.mtimeMs; let im = imgCache.get(key); if (!im) { im = await decodeRaw(fs.readFileSync(file)); imgCache.set(key, im); } return im; } catch { return null; }
}

/** App cujo ícone o botão sugere (usado quando não há imagem própria): o próprio app, o 1º app de uma sequência, ou o app vinculado à página de destino ("ir para"). */
async function iconAppPath(act: Action, store: Store, depth = 0): Promise<string | null> {
  if (depth > 2 || !act) return null;
  if (act.type === 'app' || act.type === 'quitapp') return appPath(act);
  if (DEFAULT_NAMES) return null;   // modo legado (paridade com o Python): sem ícone sugerido por sequência/página
  if (act.type === 'multi' && Array.isArray(act.steps)) { for (const st of act.steps) { const r = await iconAppPath(st, store, depth + 1); if (r) return r; } return null; }
  if (act.type === 'page' && act.op === 'goto') {
    const pg = store.getPage(Number(act.page));
    for (const a of pg?.apps ?? []) { const r = appPath({ type: 'app', app: a.name }) ?? (a.bundle ? await appPathByBundle(a.bundle) : null); if (r) return r; }
  }
  return null;
}

/** Ícone (PNG 256x256) do primeiro app vinculado à página, para a aba da página na configuração; null se não há. */
export async function pageIconFile(store: Store, pid: number): Promise<string | null> {
  for (const a of store.getPage(pid)?.apps ?? []) { const r = appPath({ type: 'app', app: a.name }) ?? (a.bundle ? await appPathByBundle(a.bundle) : null); if (r) { const f = await appIconFile(r); if (f) return f; } }
  return null;
}

/** Monitor de Recursos: anel (CPU, GPU ou RAM) ou três barras (resumo), com a leitura mais recente. Verde < 70%, amarelo 70-89%, vermelho >= 90%, cinza sem leitura. */
function resourcesCanvas(kind: string, W: number, H: number, layout = 'auto'): Canvas {
  const out = createCanvas(W, H), o = out.getContext('2d'), r = lastResources();
  o.fillStyle = '#16161a'; o.fillRect(0, 0, W, H);
  const color = (v: number | null | undefined) => (v === null || v === undefined ? '#6b7280' : v >= 90 ? '#ef4444' : v >= 70 ? '#f59e0b' : '#22c55e');
  const val = (k: string) => (!r ? null : k === 'ram' ? r.ram.percent : (r as any)[k] as number | null);
  const sz = Math.min(W, H);
  o.textAlign = 'center'; o.textBaseline = 'middle';
  if (kind === 'all' && (layout === 'line' || (layout !== 'rows' && W >= H * 1.5))) {   // em linha: três anéis lado a lado (automático: botão largo)
    const cw = W / 3, R = Math.max(6, Math.min(cw * 0.36, H * 0.3)), lw = Math.max(4, R * 0.28), cy = H * 0.44, big = Math.max(8, Math.round(R * 0.7)), small = Math.max(7, Math.round(R * 0.42));
    ['cpu', 'gpu', 'ram'].forEach((k, n) => {
      const v = val(k), cx = cw * n + cw / 2;
      o.lineWidth = lw; o.lineCap = 'round'; o.strokeStyle = '#374151'; o.beginPath(); o.arc(cx, cy, R, 0, Math.PI * 2); o.stroke();
      if (v !== null && v > 0) { o.strokeStyle = color(v); o.beginPath(); o.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(100, v) / 100); o.stroke(); }
      o.textAlign = 'center'; o.fillStyle = '#f9fafb'; o.font = `bold ${big}px MontserratDeck`; o.fillText(v === null ? '--' : String(v), cx, cy);
      o.fillStyle = '#9ca3af'; o.font = `bold ${small}px MontserratDeck`; o.fillText(k.toUpperCase(), cx, Math.min(H - small * 0.7, cy + R + lw * 0.5 + small * 0.9));
    });
    return out;
  }
  if (kind === 'all') {
    const rows = ['cpu', 'gpu', 'ram'], rh = H / 3, pad = Math.round(W * 0.07), fs = Math.max(9, Math.round(Math.min(rh * 0.36, W * 0.16)));
    rows.forEach((k, n) => {
      const v = val(k), y = n * rh, bh = Math.max(4, Math.round(rh * 0.14)), by = y + rh * 0.62, bw = W - 2 * pad;
      o.font = `bold ${fs}px MontserratDeck`; o.fillStyle = '#9ca3af'; o.textAlign = 'left'; o.fillText(k.toUpperCase(), pad, y + rh * 0.3);
      o.fillStyle = '#f9fafb'; o.textAlign = 'right'; o.fillText(v === null ? '--' : v + '%', W - pad, y + rh * 0.3);
      o.fillStyle = '#374151'; o.beginPath(); o.roundRect(pad, by, bw, bh, bh / 2); o.fill();
      if (v !== null) { o.fillStyle = color(v); o.beginPath(); o.roundRect(pad, by, Math.max(bh, bw * Math.min(100, v) / 100), bh, bh / 2); o.fill(); }
    });
    return out;
  }
  const v = val(kind), cx = W / 2, cy = H * 0.46, R = sz * 0.34, lw = Math.max(5, sz * 0.09);
  o.lineWidth = lw; o.lineCap = 'round'; o.strokeStyle = '#374151'; o.beginPath(); o.arc(cx, cy, R, 0, Math.PI * 2); o.stroke();
  if (v !== null && v > 0) { o.strokeStyle = color(v); o.beginPath(); o.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(100, v) / 100); o.stroke(); }
  o.fillStyle = '#f9fafb'; o.font = `bold ${Math.round(sz * 0.25)}px MontserratDeck`; o.fillText(v === null ? '--' : v + '%', cx, cy);
  if (kind === 'ram' && r) { o.fillStyle = '#9ca3af'; o.font = `bold ${Math.max(8, Math.round(sz * 0.12))}px MontserratDeck`; o.fillText(`${r.ram.usedGB}/${r.ram.totalGB} GB`, cx, cy + R + lw * 1.1); }
  else { o.fillStyle = '#9ca3af'; o.font = `bold ${Math.max(8, Math.round(sz * 0.13))}px MontserratDeck`; o.fillText(kind.toUpperCase(), cx, cy + R + lw * 1.1); }
  return out;
}

/** Controle deslizante: trilho escuro com o ícone do que ele controla e setas nas pontas (modos relativos). `level` (0-1000) só na prévia da página: na placa o preenchimento é desenhado pelo firmware (resposta imediata ao dedo). */
function sliderCanvas(act: Action, W: number, H: number, c: number, r: number, level: number | null): Canvas {
  const out = createCanvas(W, H), o = out.getContext('2d'), pad = Math.max(3, Math.round(Math.min(W, H) * 0.06)), rr = Math.max(6, Math.min(W, H) * 0.16);
  const hex = (n: number) => '#' + n.toString(16).padStart(6, '0'), col = hex(sliderColor(act as any)), horiz = sliderAxis(act, c, r) === 'h';
  o.fillStyle = '#16161a'; o.fillRect(0, 0, W, H);
  o.save(); o.beginPath(); o.roundRect(pad, pad, W - 2 * pad, H - 2 * pad, rr); o.clip();
  o.fillStyle = '#242832'; o.fillRect(0, 0, W, H);
  if (level !== null && isAbsolute(act)) { o.globalAlpha = 0.55; o.fillStyle = col; if (horiz) o.fillRect(0, 0, W * level / 1000, H); else o.fillRect(0, H * (1 - level / 1000), W, H * level / 1000); o.globalAlpha = 1; }
  o.restore();
  const cx = W / 2, cy = H / 2, s = Math.min(W, H) * 0.3, mode = String(act.mode);
  o.fillStyle = '#f4f4f6'; o.strokeStyle = '#f4f4f6'; o.lineWidth = Math.max(2, s * 0.14); o.lineCap = 'round'; o.lineJoin = 'round';
  if (mode === 'volume' || mode === 'appvolume') {   // alto-falante com ondas
    o.beginPath(); o.moveTo(cx - s * 0.9, cy - s * 0.35); o.lineTo(cx - s * 0.45, cy - s * 0.35); o.lineTo(cx + s * 0.05, cy - s * 0.8); o.lineTo(cx + s * 0.05, cy + s * 0.8); o.lineTo(cx - s * 0.45, cy + s * 0.35); o.lineTo(cx - s * 0.9, cy + s * 0.35); o.closePath(); o.fill();
    o.beginPath(); o.arc(cx + s * 0.05, cy, s * 0.5, -0.9, 0.9); o.stroke(); o.beginPath(); o.arc(cx + s * 0.05, cy, s * 0.95, -0.9, 0.9); o.stroke();
  } else if (mode === 'brightness') {   // sol
    o.beginPath(); o.arc(cx, cy, s * 0.42, 0, Math.PI * 2); o.fill();
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; o.beginPath(); o.moveTo(cx + Math.cos(a) * s * 0.68, cy + Math.sin(a) * s * 0.68); o.lineTo(cx + Math.cos(a) * s * 0.95, cy + Math.sin(a) * s * 0.95); o.stroke(); }
  } else {   // linha do tempo: régua com marcador
    o.beginPath(); o.moveTo(cx - s, cy + s * 0.15); o.lineTo(cx + s, cy + s * 0.15); o.stroke();
    for (let k = -2; k <= 2; k++) { o.beginPath(); o.moveTo(cx + k * s * 0.5, cy + s * 0.15); o.lineTo(cx + k * s * 0.5, cy + s * (k === 0 ? 0.6 : 0.4)); o.stroke(); }
    o.fillStyle = col; o.beginPath(); o.moveTo(cx - s * 0.22, cy - s * 0.75); o.lineTo(cx + s * 0.22, cy - s * 0.75); o.lineTo(cx, cy - s * 0.3); o.closePath(); o.fill();
  }
  if (!isAbsolute(act)) {   // setas nas pontas (modos relativos): mostram a direção do arrasto
    o.fillStyle = col; const a = Math.max(5, Math.min(W, H) * 0.12), m = pad + a * 1.2;
    const tri = (x: number, y: number, dx: number, dy: number) => { o.beginPath(); o.moveTo(x + dx * a, y + dy * a); o.lineTo(x - dy * a * 0.8 - dx * a * 0.4, y + dx * a * 0.8 - dy * a * 0.4); o.lineTo(x + dy * a * 0.8 - dx * a * 0.4, y - dx * a * 0.8 - dy * a * 0.4); o.closePath(); o.fill(); };
    if (horiz) { tri(m, cy, -1, 0); tri(W - m, cy, 1, 0); } else { tri(cx, m, 0, -1); tri(cx, H - m, 0, 1); }
  }
  return out;
}

/** Botão com estado: bolinha no canto (verde = ligado, vermelha = alerta/mudo, cinza = desligado) e, desligado, a imagem escurecida. */
function withState(cv: Canvas, st: 'on' | 'off' | 'alert' | null): Canvas {
  if (!st) return cv;
  const o = cv.getContext('2d'), W = cv.width, H = cv.height, r = Math.max(4, Math.round(Math.min(W, H) * 0.075)), cx = W - r - 3, cy = r + 3;
  if (st === 'off') { o.fillStyle = 'rgba(0,0,0,0.5)'; o.fillRect(0, 0, W, H); }
  o.beginPath(); o.arc(cx, cy, r + 1.5, 0, 7); o.fillStyle = 'rgba(0,0,0,0.65)'; o.fill();
  o.beginPath(); o.arc(cx, cy, r, 0, 7); o.fillStyle = st === 'on' ? '#35d07f' : st === 'alert' ? '#ff5c5c' : '#8b8d98'; o.fill();
  return cv;
}
export async function renderButton(store: Store, pid: number, i: number, useSpan = true, withLevel = false): Promise<Canvas> {
  return withState(await renderButtonBase(store, pid, i, useSpan, withLevel), stateOf(store.getButton(pid, i)?.action));
}
async function renderButtonBase(store: Store, pid: number, i: number, useSpan = true, withLevel = false): Promise<Canvas> {
  const b = JSON.parse(JSON.stringify(store.getButton(pid, i)!)) as NonNullable<ReturnType<Store['getButton']>>;
  const sp = useSpan ? store.spanOf(pid, i) : { c: 1, r: 1 }, tb = store.tileBox(sp.c, sp.r), kk = Math.max(1, Math.min(tb.w / store.geom.w, tb.h / store.geom.h));   // botão juntado: medidas do tile; ícones crescem junto (kk = 1 em botão 1x1)
  const { w: W, h: H, bar } = tb, named = displayLabel(b, (id) => store.getPage(id)?.name) !== '';   // sem título: não há faixa, e o ícone usa o botão todo
  const avail = named ? H - bar : H;   // altura livre acima da faixa do nome (onde ficam ícone e símbolo)
  const avail1 = named ? store.geom.h - store.tileBox(1, 1).bar : store.geom.h, fitK = (sp.c > 1 || sp.r > 1) ? Math.min(W, avail) / Math.min(store.geom.w, avail1) : kk;   // botão juntado: o ícone cresce com o MENOR espaço livre (largura ou altura): tile largo ou alto também aproveita o espaço
  const big = Math.round((named ? 44 : 56) * Math.max(kk, fitK)), isz = Math.min(big, avail - 8), iy = isz === 44 ? Math.max(6, Math.floor((avail - 44) / 2)) : Math.floor((avail - isz) / 2);   // ícone: 44 px com nome (56 sem), menor em botões baixos
  if (b.image && fs.existsSync(path.join(UPLOADS, b.image))) {
    const up = await load(path.join(UPLOADS, b.image));
    if (up) return toCanvas(/\.gif$/i.test(b.image) ? fitInside(up, W, H) : pilFit(up, W, H, 'lanczos'));   // GIF: inteiro no botão (sem cortar)   // ImageOps.fit(.convert("RGB"), (W, H), LANCZOS)
  }
  const act: Action = b.action || ({} as Action); let icon: Raster | null = null, base: RGB | null = null;
  if (act.type === 'plugin') {   // ícone enviado pelo plugin: ocupa a largura do botão (a faixa do nome da placa cobre a parte de baixo); cantos transparentes sobre fundo escuro
    const out = createCanvas(W, H), o = out.getContext('2d'); o.fillStyle = '#16161a'; o.fillRect(0, 0, W, H);
    const r = hooks.pluginIcon?.(b);
    const ps = Math.min(W, H);   // ícone do plugin: quadrado do tamanho do botão (a menor medida)
    if (r) o.drawImage(toCanvas(pilResize(r, ps, ps, 'lanczos', true)), Math.trunc((W - ps) / 2), 0);
    else { const g = glyphCanvas((c) => centerText(c, '...', 84)); o.drawImage(toCanvas(pilResize(toRaster(g), isz, isz, 'lanczos', true)), Math.trunc((W - isz) / 2), iy); }
    return out;
  }
  if (act.type === 'widget') return widgetCanvas(String(act.kind), W, H);
  if (act.type === 'notif') return notifCanvas(act, W, H, store);
  if (act.type === 'slider') return sliderCanvas(act, W, H, sp.c, sp.r, withLevel ? levelOf(`${pid}:${i}`) : null);
  if (act.type === 'resources') return resourcesCanvas(String(act.res ?? 'all'), W, H, String(act.layout ?? 'auto'));
  const appFor = act.type === 'plugin' ? null : await iconAppPath(act, store);   // ícone do app ligado à ação (o próprio, o da sequência ou o da página de destino)
  if (act.type === 'app' || act.type === 'quitapp' || appFor) { const p = appFor; if (p) { const f = await appIconFile(p); icon = f ? await load(f) : null; } }
  if (!icon && ['page', 'url', 'text', 'hotkey', 'media', 'multi', 'folder', 'quitapp', 'webhook', 'homeassistant', 'mqtt'].includes(act.type)) { try { const [g, c] = actionGlyph(act); icon = toRaster(g); base = c; } catch { icon = null; } }
  const col: RGB = hexRgb(b.color) ?? base ?? (icon ? dominant(icon) : [52, 56, 72]);

  const grad = createCanvas(W, H), g = grad.getContext('2d');
  for (let y = 0; y < H; y++) {
    const k = 1.0 - 0.55 * (y / (H - 1));
    g.fillStyle = `rgb(${col.map((c) => Math.min(255, Math.trunc(c * k))).join(',')})`; g.fillRect(0, y, W, 1);
  }
  if (icon) {
    const out = createCanvas(W, H), o = out.getContext('2d'); o.drawImage(grad, 0, 0);
    const ic = toCanvas(pilResize(icon, isz, isz, 'lanczos', true)), x = Math.trunc((W - isz) / 2), y = iy;   // icon.resize((44, 44), LANCZOS)
    const sh = createCanvas(W, H), s = sh.getContext('2d');   // sombra: máscara alfa do ícone (110/255), deslocada (+2,+5) e desfocada (σ=4)
    s.drawImage(ic, x + 2, y + 5); s.globalCompositeOperation = 'source-in'; s.fillStyle = `rgba(0,0,0,${110 / 255})`; s.fillRect(0, 0, W, H);
    o.filter = 'blur(4px)'; o.drawImage(sh, 0, 0); o.filter = 'none';
    o.drawImage(ic, x, y);
    if (act.type === 'quitapp' && appFor) {   // "fechar": o ícone do app com um selo vermelho de X no canto
      const r = Math.max(6, Math.round(isz * 0.24)), bx = x + isz - r + 2, by = y + r - 2;
      o.fillStyle = '#e5484d'; o.beginPath(); o.arc(bx, by, r, 0, Math.PI * 2); o.fill();
      o.strokeStyle = '#fff'; o.lineWidth = Math.max(2, r / 4); o.lineCap = 'round'; const d = r * 0.42;
      o.beginPath(); o.moveTo(bx - d, by - d); o.lineTo(bx + d, by + d); o.moveTo(bx + d, by - d); o.lineTo(bx - d, by + d); o.stroke();
    }
    return out;
  }
  // botão vazio: um "+" discreto, esmaecido (blend 0,35 sobre o fundo escurecido)
  const cx = Math.trunc(W / 2), cy = Math.floor(avail / 2), arm = Math.min(Math.round(11 * Math.max(kk, fitK)), Math.floor((avail - 4) / 2)), p = grad.getContext('2d'); p.fillStyle = '#fff';   // 26 e 11 na grade padrão
  p.beginPath(); p.roundRect(cx - 2, cy - arm, 5, 2 * arm + 1, 2); p.fill(); p.beginPath(); p.roundRect(cx - arm, cy - 2, 2 * arm + 1, 5, 2); p.fill();
  const out = createCanvas(W, H), o = out.getContext('2d');
  o.fillStyle = `rgb(${col.map((c) => Math.trunc(c / 3)).join(',')})`; o.fillRect(0, 0, W, H); o.globalAlpha = 0.35; o.drawImage(grad, 0, 0);
  return out;
}

/** RGB565 little-endian (o formato que a placa espera). */
export function toRgb565(cv: Canvas): Buffer {
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, out = Buffer.alloc(cv.width * cv.height * 2);
  for (let k = 0, o = 0; k < d.length; k += 4, o += 2) { const v = ((d[k]! >> 3) << 11) | ((d[k + 1]! >> 2) << 5) | (d[k + 2]! >> 3); out[o] = v & 255; out[o + 1] = v >> 8; }
  return out;
}

const rawCache = new Map<string, Buffer>();
/** Esquece a imagem em cache do botão (quando o conteúdo do slot troca de dono). */
export function invalidateRaw(pid: number, i: number): void { for (const k of [...rawCache.keys()]) if (k.startsWith(`${pid}:${i}:`)) rawCache.delete(k); }
/** O que, fora do botão, muda o ícone sugerido (apps vinculados às páginas de destino): entra na chave do cache. */
function iconDeps(act: Action | null | undefined, store: Store, depth = 0): string {
  if (!act || depth > 2) return '';
  if (act.type === 'page' && act.op === 'goto') return JSON.stringify(store.getPage(Number(act.page))?.apps ?? '');
  if (act.type === 'multi' && Array.isArray(act.steps)) return act.steps.map((st: Action) => iconDeps(st, store, depth + 1)).join('|');
  return '';
}
export async function renderRaw(store: Store, pid: number, i: number, useSpan = true): Promise<Buffer> {
  const bt = store.getButton(pid, i)!, sp = useSpan ? store.spanOf(pid, i) : { c: 1, r: 1 }, g = store.tileBox(sp.c, sp.r), key = `${pid}:${i}:${bt.imgrev}:${hooks.pluginVersion?.(bt) ?? 0}:${bt.action?.type === 'resources' || bt.action?.type === 'widget' || bt.action?.type === 'notif' ? resVer.get(`${pid}:${i}`) ?? 0 : ''}:${g.w}x${g.h}x${g.bar}:${iconDeps(bt.action, store)}:${stateTag(bt.action)}`, hit = rawCache.get(key);
  if (hit) return hit;
  const buf = toRgb565(await renderButton(store, pid, i, useSpan));
  for (const k of [...rawCache.keys()]) if (k.startsWith(`${pid}:${i}:`)) rawCache.delete(k);
  rawCache.set(key, buf); return buf;
}

/** Como o botão aparece na placa (imagem + faixa do nome), em 2x (PNG). */
export async function renderPreview(store: Store, pid: number, i: number): Promise<Buffer> {
  const sp = store.spanOf(pid, i), tb = store.tileBox(sp.c, sp.r), k = 2, { w: W, h: H, bar: BAR_H } = tb;
  const cv = createCanvas(W * k, H * k), c = cv.getContext('2d');
  c.drawImage(toCanvas(pilResize(toRaster(await renderButton(store, pid, i, true, true)), W * k, H * k, 'bicubic', false)), 0, 0);   // .resize((W*2, H*2), BICUBIC)
  const { text, fs: px } = labelFit(store.getButton(pid, i)!, (id) => store.getPage(id)?.name, tb), [asc, desc] = metrics(px * k), lh = asc + desc, lines = text.split('\n');
  if (!text) return cv.toBuffer('image/png');   // sem título: sem faixa preta
  c.fillStyle = 'rgba(0,0,0,0.549)'; c.fillRect(0, (H - BAR_H) * k, W * k, BAR_H * k);
  let y = (H - BAR_H) * k + Math.floor((BAR_H * k - lh * lines.length) / 2);
  c.fillStyle = '#fff'; c.font = `${px * k}px MontserratDeck`; c.textBaseline = 'alphabetic';
  for (const ln of lines) { c.fillText(ln, (W * k - textWidth(ln, px * k)) / 2, y + asc); y += lh; }
  return cv.toBuffer('image/png');
}

/** Imagem enviada pelo usuário: recorta/redimensiona para o dobro do botão e devolve o PNG a guardar. */
export async function processUpload(data: Buffer, W: number, H: number): Promise<Buffer> {
  const im = await decodeRaw(data);
  return toCanvas(pilFit(im, W * 2, H * 2, 'lanczos')).toBuffer('image/png');
}
