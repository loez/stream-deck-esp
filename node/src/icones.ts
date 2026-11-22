// Pacote local de ícones (Lucide + Simple Icons em assets/icones/, gerado por tools/gerar-icones.mjs). Nada é buscado na internet.
// O ícone escolhido vira uma imagem de botão comum (PNG em uploads/): mesmo caminho do "Enviar imagem".
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ASSETS } from './env.ts';

const DIR = path.join(ASSETS, 'icones');
type Node = [string, Record<string, string | number>];
let lucide: Record<string, Node[]> | null = null, simple: Record<string, [string, string, string]> | null = null, indexBuf: Buffer | null = null;
const load = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as T;

export const HEX = /^#[0-9a-fA-F]{6}$/;
export const ICON_ID = /^(l|s):[a-z0-9][a-z0-9-]*$/;

/** index.json cru (nomes, palavras-chave, categorias, dicionário pt→en), para a página. */
export function iconIndex(): Buffer { return (indexBuf ??= fs.readFileSync(path.join(DIR, 'index.json'))); }

const esc = (s: string | number) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** SVG do ícone ("l:house" = Lucide, "s:spotify" = logo de marca) na cor pedida; null se não existe. stroke = espessura do traço (só Lucide). */
export function iconSvg(id: string, color = '#ffffff', stroke = 2): { svg: string; title: string; brand?: string } | null {
  if (!ICON_ID.test(id) || !HEX.test(color)) return null;
  const slug = id.slice(2);
  if (id[0] === 'l') {
    if (!lucide) lucide = load('lucide.json'); const L = lucide as Record<string, Node[]>, nodes = Object.hasOwn(L, slug) ? L[slug] : undefined; if (!nodes) return null;
    const inner = nodes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`).join('');
    const w = Math.min(4, Math.max(1, Number(stroke) || 2));
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`, title: slug };
  }
  if (!simple) simple = load('simple.json'); const S = simple as Record<string, [string, string, string]>, e = Object.hasOwn(S, slug) ? S[slug] : undefined; if (!e) return null;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="${esc(e[2])}"/></svg>`, title: e[0], brand: '#' + e[1] };
}

/** PNG (2x do botão) com o ícone centralizado sobre `bg`. `bar`: altura (px do botão) da faixa do nome por cima, que fica de fora da área do ícone; 0 = sem título. */
export async function renderIcon(id: string, color: string, bg: string, stroke: number, W: number, H: number, bar: number): Promise<Buffer | null> {
  if (!HEX.test(bg)) return null;
  const ic = iconSvg(id, color, stroke); if (!ic) return null;
  const k = 4, cw = W * k, ch = H * k, area = (H - bar) * k, size = Math.floor(Math.min(cw, area) * (bar ? 0.78 : 0.62));
  const cv = createCanvas(W * 2, H * 2), c = cv.getContext('2d'), big = createCanvas(cw, ch), bc = big.getContext('2d');
  bc.fillStyle = bg; bc.fillRect(0, 0, cw, ch);
  const im = await loadImage(Buffer.from(ic.svg)); bc.drawImage(im, Math.round((cw - size) / 2), Math.round((area - size) / 2), size, size);
  c.imageSmoothingQuality = 'high'; c.drawImage(big, 0, 0, W * 2, H * 2);
  return cv.toBuffer('image/png');
}
