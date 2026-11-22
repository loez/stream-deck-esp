// GIFs animados nos botões: decodifica o GIF (compondo os quadros com disposal/transparência), ajusta ao tamanho do botão (tile) e entrega quadros RGB565 + atrasos
// para a placa. Limites (quadros, atraso mínimo, bytes) protegem a RAM da placa e o preenchimento da tela (SPI): ver `AnimLimits`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GifReader } from 'omggif';
import { UPLOADS } from './env.ts';
import type { Store, Tile } from './config.ts';
import { hooks } from './hooks.ts';
import { pilResize, fitInside } from './resample.ts';
import { pilFit } from './resample.ts';
import type { Raster } from './resample.ts';

// Qualquer GIF é aceito (até 25 MB, 8192 px): o app o adapta sozinho ao enviar - reduz a imagem para no máx. GIF_KEEP_SIDE px e mantém no máx. GIF_KEEP_FRAMES quadros (somando o tempo dos descartados)
export const GIF_MAX_BYTES = 25_000_000, GIF_HARD_SIDE = 8192, GIF_KEEP_SIDE = 640, GIF_KEEP_FRAMES = 120;
export type GifFrames = { w: number; h: number; frames: { rgba: Uint8ClampedArray; delay: number }[] };   // quadros já compostos (tela cheia, RGBA); delay em ms
export type AnimLimits = { minDelay: number; maxFrames: number; maxBytes: number };                      // atraso mínimo entre quadros (ms), máximo de quadros e de bytes (todos os quadros do botão)
export const DEFAULT_LIMITS: AnimLimits = { minDelay: 70, maxFrames: 32, maxBytes: 480_000 };
export type TileAnim = { n: number; delays: number[]; frames: Buffer[]; bytes: number };               // frames: RGB565 little-endian, w*h*2 bytes cada

export const isGif = (buf: Buffer): boolean => buf.length > 13 && buf.toString('latin1', 0, 4) === 'GIF8';

/** Decodifica um GIF compondo cada quadro sobre o anterior (disposal 0/1 mantém, 2 limpa a área, 3 restaura). Lança Error se inválido ou grande demais. */
export function decodeGif(buf: Buffer): GifFrames {
  if (buf.length > GIF_MAX_BYTES) throw new Error('GIF grande demais (máximo 25 MB)');
  let r: GifReader; try { r = new GifReader(buf); } catch { throw new Error('GIF inválido'); }
  const W = r.width, H = r.height, n = r.numFrames();
  if (!W || !H || W > GIF_HARD_SIDE || H > GIF_HARD_SIDE) throw new Error(`GIF com dimensões fora do possível (máximo ${GIF_HARD_SIDE}x${GIF_HARD_SIDE})`);
  if (n < 1) throw new Error('GIF sem quadros');
  const sc = Math.min(1, GIF_KEEP_SIDE / Math.max(W, H)), ow = Math.max(1, Math.round(W * sc)), oh = Math.max(1, Math.round(H * sc)), step = Math.ceil(n / GIF_KEEP_FRAMES);   // adaptação: reduz a imagem e, se tiver quadros demais, guarda 1 a cada `step`
  const canvas = new Uint8ClampedArray(W * H * 4), frames: GifFrames['frames'] = [];
  let saved: Uint8ClampedArray | null = null, prev: ReturnType<GifReader['frameInfo']> | null = null;
  for (let i = 0; i < n; i++) {
    const info = r.frameInfo(i);
    if (prev) {   // descarte do quadro anterior, aplicado antes de desenhar o atual
      if (prev.disposal === 2) { for (let y = prev.y; y < Math.min(H, prev.y + prev.height); y++) canvas.fill(0, (y * W + prev.x) * 4, (y * W + Math.min(W, prev.x + prev.width)) * 4); }
      else if (prev.disposal === 3 && saved) canvas.set(saved);
    }
    saved = info.disposal === 3 ? canvas.slice() : null;
    r.decodeAndBlitFrameRGBA(i, canvas);
    const d = (info.delay || 0) * 10;   // centésimos -> ms; 0/1 centésimo = "o mais rápido possível": navegadores usam 100 ms
    const dd = d < 20 ? 100 : d;
    if (i % step === 0) frames.push({ rgba: sc < 1 ? pilResize({ w: W, h: H, data: canvas }, ow, oh, 'bicubic', true).data : canvas.slice(), delay: dd });
    else frames[frames.length - 1]!.delay += dd;   // quadro descartado: o tempo dele vai para o anterior
    prev = info;
  }
  return { w: ow, h: oh, frames };
}

/** RGBA -> RGB565 little-endian (o formato da placa), compondo antes sobre o fundo escuro dos botões (GIFs com transparência). */
function toRgb565(r: Raster): Buffer {
  const out = Buffer.alloc(r.w * r.h * 2), d = r.data;
  for (let k = 0, o = 0; k < d.length; k += 4, o += 2) {
    const a = d[k + 3]! / 255, R = Math.round(d[k]! * a + 22 * (1 - a)), G = Math.round(d[k + 1]! * a + 22 * (1 - a)), B = Math.round(d[k + 2]! * a + 26 * (1 - a));
    const v = ((R >> 3) << 11) | ((G >> 2) << 5) | (B >> 3); out[o] = v & 255; out[o + 1] = v >> 8;
  }
  return out;
}

/** Escolhe quais quadros ficam (e quanto cada um dura): atraso mínimo e teto de quadros. Descarta os quadros "curtos demais" somando o tempo ao anterior. */
export function pickFrames(delays: number[], lim: AnimLimits): { idx: number[]; delay: number[] } {
  let idx: number[] = [], delay: number[] = [];
  delays.forEach((d, i) => { if (idx.length && delay[delay.length - 1]! < lim.minDelay) delay[delay.length - 1]! += d; else { idx.push(i); delay.push(d); } });
  if (idx.length > lim.maxFrames) {   // ainda demais: reduz uniformemente (cada grupo mantém o 1º quadro e soma o tempo)
    const step = Math.ceil(idx.length / lim.maxFrames), ni: number[] = [], nd: number[] = [];
    for (let k = 0; k < idx.length; k += step) { ni.push(idx[k]!); nd.push(delay.slice(k, k + step).reduce((a, b) => a + b, 0)); }
    idx = ni; delay = nd;
  }
  return { idx, delay };
}

/** Ícone quadrado (GIF de plugin) no topo do botão, centralizado e sobre o fundo escuro: o mesmo enquadramento do ícone estático de plugin. */
function containFrame(src: Raster, w: number, h: number): Raster {
  const ps = Math.min(w, h), sq = pilResize(src, ps, ps, 'bicubic', true), out = new Uint8ClampedArray(w * h * 4), x0 = Math.trunc((w - ps) / 2);
  for (let k = 0; k < out.length; k += 4) { out[k] = 22; out[k + 1] = 22; out[k + 2] = 26; out[k + 3] = 255; }
  for (let y = 0; y < ps; y++) for (let x = 0; x < ps; x++) {
    const s = (y * ps + x) * 4, o = (y * w + x0 + x) * 4, a = sq.data[s + 3]! / 255;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(sq.data[s + c]! * a + out[o + c]! * (1 - a));
  }
  return { w, h, data: out };
}

/** Quadros do GIF no tamanho do botão, prontos para a placa: "cover" (imagem enviada pelo usuário, recorta) ou "contain" (ícone de plugin, quadrado centralizado).
 *  Respeita os limites (se os bytes passarem do teto, usa menos quadros). */
export function tileFrames(g: GifFrames, w: number, h: number, lim: AnimLimits = DEFAULT_LIMITS, mode: 'cover' | 'contain' | 'fit' = 'cover'): TileAnim {
  const per = w * h * 2, byBytes = Math.max(1, Math.floor(lim.maxBytes / per));
  const { idx, delay } = pickFrames(g.frames.map((f) => f.delay), { ...lim, maxFrames: Math.min(lim.maxFrames, byBytes) });
  const frames = idx.map((i) => { const src: Raster = { w: g.w, h: g.h, data: g.frames[i]!.rgba }; return toRgb565(mode === 'contain' ? containFrame(src, w, h) : mode === 'fit' ? fitInside(src, w, h) : pilFit(src, w, h, 'bicubic', true)); });
  return { n: frames.length, delays: delay.map((d) => Math.min(65535, d)), frames, bytes: frames.length * per };
}

/** Formato enviado à placa (/api/anim/N.bin, tudo little-endian): u16 n, u16 reservado, n x u16 atraso (ms), n quadros RGB565. */
export function encodeAnim(a: TileAnim): Buffer {
  const head = Buffer.alloc(4 + a.n * 2); head.writeUInt16LE(a.n, 0); head.writeUInt16LE(0, 2); a.delays.forEach((d, k) => head.writeUInt16LE(d, 4 + k * 2));
  return Buffer.concat([head, ...a.frames]);
}

// cache: GIF decodificado e quadros por tamanho de botão/limites (pequeno: as animações da página atual)
const decoded = new Map<string, GifFrames>(), tiled = new Map<string, TileAnim>();
const touch = <T>(m: Map<string, T>, k: string, v: T, max: number): T => { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value!); return v; };
export function animFor(key: string, ver: number, src: GifFrames | (() => Buffer), w: number, h: number, lim: AnimLimits, mode: 'cover' | 'contain' | 'fit' = 'cover'): TileAnim {
  const k = `${key}:${ver}:${mode}:${w}x${h}:${lim.minDelay}:${lim.maxFrames}:${lim.maxBytes}`, hit = tiled.get(k);
  if (hit) return touch(tiled, k, hit, 24);
  const dk = `${key}:${ver}`, g = typeof src === 'function' ? (decoded.get(dk) ?? decodeGif(src())) : src;
  if (typeof src === 'function') touch(decoded, dk, g, 6);
  return touch(tiled, k, tileFrames(g, w, h, lim, mode), 24);
}

// ---------- botões animados de uma página: orçamento de memória e de preenchimento da tela ----------
export const MAX_ANIM_TILES = 8, PAGE_ANIM_BYTES = 3_000_000, DEFAULT_FILL = 1_000_000;   // botões animados por página; bytes de quadros por página; pixels/s úteis (a placa informa o dela em fill=)
export type AnimTile = { slot: number; i: number; w: number; h: number; key: string; mtime: number; src: GifFrames | (() => Buffer); mode: 'cover' | 'contain' | 'fit' };   // key + mtime (ou versão do plugin) identificam a origem para o cache; src = GIF já decodificado (plugin) ou leitura do arquivo
/** Botões animados da página (entre os botões visíveis): GIF enviado pelo usuário ou GIF de plugin (estados tipo 3/4), limitados a MAX_ANIM_TILES. */
export function animTiles(store: Store, pid: number, tiles: Tile[]): AnimTile[] {
  const out: AnimTile[] = [], pg = store.getPage(pid);
  for (const t of tiles) {
    const b = pg?.buttons[t.slot]; if (!b) continue;
    if (b.image) {
      if (!/\.gif$/i.test(b.image)) continue;   // imagem estática enviada: sem animação (e ela vale mais que o ícone do plugin)
      const file = path.join(UPLOADS, b.image); let st: fs.Stats; try { st = fs.statSync(file); } catch { continue; }
      out.push({ slot: t.slot, i: t.i, w: t.w, h: t.h, key: file, mtime: st.mtimeMs, src: () => fs.readFileSync(file), mode: 'fit' });
    } else if (b.action?.type === 'plugin') {
      const pa = hooks.pluginAnim?.(b); if (!pa) continue;
      out.push({ slot: t.slot, i: t.i, w: t.w, h: t.h, key: `plugin:${String(b.action.actionid)}`, mtime: pa.ver, src: pa.gif, mode: 'contain' });
    } else continue;
    if (out.length >= MAX_ANIM_TILES) break;
  }
  return out;
}
/** Limites comuns dos botões animados da página: o atraso mínimo sobe até a soma (pixels x quadros/s) caber no preenchimento da placa; a memória é dividida entre eles. */
export function planLimits(list: AnimTile[], fill: number): AnimLimits {
  const area = list.reduce((a, t) => a + t.w * t.h, 0) || 1, f = fill > 0 ? fill : DEFAULT_FILL;
  return { minDelay: Math.max(DEFAULT_LIMITS.minDelay, Math.ceil((1000 * area) / f)), maxFrames: DEFAULT_LIMITS.maxFrames, maxBytes: Math.min(DEFAULT_LIMITS.maxBytes, Math.floor(PAGE_ANIM_BYTES / Math.max(1, list.length))) };
}
export const tileAnim = (t: AnimTile, lim: AnimLimits): TileAnim => animFor(t.key, t.mtime, t.src, t.w, t.h, lim, t.mode);
/** Versão da animação (inteiro de 31 bits): muda quando o arquivo, o tamanho do botão ou os limites mudam; a placa baixa de novo só quando muda. */
export const animRev = (t: AnimTile, lim: AnimLimits): number => crypto.createHash('sha1').update(`${t.key}:${t.mtime}:${t.mode}:${t.w}x${t.h}:${lim.minDelay}:${lim.maxFrames}:${lim.maxBytes}`).digest().readUInt32BE(0) & 0x7fffffff;
