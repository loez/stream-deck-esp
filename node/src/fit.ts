// Texto do botão: o servidor decide quebra de linha e tamanho (mesma fonte do firmware: Montserrat), a placa só desenha.
// Tenta 12, 11 e 10 px; usa o maior em que o nome cabe em até 2 linhas sem partir palavra no meio. Se nem a 10 px couber, corta com "...".
//
// Medição: o servidor Python mede com o Pillow, que soma os avanços dos glifos ARREDONDADOS para pixels inteiros (hinting do FreeType).
// Aqui isso é reproduzido com a mesma aritmética de ponto fixo do FreeType (26.6 / 16.16): idêntico ao Pillow em 100% dos textos testados.
import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import { ASSETS } from './env.ts';
import { tr } from './i18n.ts';
import { cps, slice, strip } from './util.ts';
import type { Action, Button } from './config.ts';
import { hooks } from './hooks.ts';
import { DEFAULT_NAMES } from './env.ts';

/** Espaço do texto: largura útil (px) na faixa do nome, máximo de linhas e tamanhos tentados (do maior para o menor). Depende da grade e da fonte escolhidas (settings.ts). */
export type FitBox = { textW: number; maxLines: number; sizes: number[] };
export const DEFAULT_BOX: FitBox = { textW: 66, maxLines: 2, sizes: [12, 11, 10] };   // grade 4x2, fonte 12
export const FONT_PATH = path.join(ASSETS, 'montserrat.ttf');

const buf = fs.readFileSync(FONT_PATH);
export const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const UPM = font.unitsPerEm;

// FT_DivFix / FT_MulFix (FreeType)
const divFix = (a: number, b: number) => Math.trunc((a * 65536 + Math.trunc(b / 2)) / b);
const mulFix = (a: number, b: number) => Math.floor((a * b + 0x8000) / 65536);

const advCache = new Map<string, number>();
/** Avanço do glifo em pixels inteiros (hinted), como o Pillow/FreeType. */
function advance(ch: string, px: number): number {
  const key = px + ':' + ch;
  let v = advCache.get(key);
  if (v === undefined) {
    const g = font.charToGlyph(ch);
    v = (mulFix(g.advanceWidth ?? 0, divFix(px * 64, UPM)) + 32) >> 6;
    advCache.set(key, v);
  }
  return v;
}
/** font.getlength(text) do Pillow. */
export function textWidth(text: string, px: number): number {
  let s = 0;
  for (const ch of text) s += advance(ch, px);
  return s;
}
/** font.getmetrics() do Pillow: (ascent, descent) em pixels, arredondados para cima. */
export function metrics(px: number): [number, number] {
  return [Math.ceil((font.ascender * px) / UPM), Math.ceil((-font.descender * px) / UPM)];
}

const words = (t: string) => t.split(/\s+/).filter(Boolean);   // str.split() do Python

/** Quebra gulosa em espaços. Retorna [linhas, partiuPalavra]. */
function wrapWords(text: string, px: number, TEXT_W: number): [string[], boolean] {
  const lines: string[] = []; let cur = '', broke = false;
  for (const w0 of words(text)) {
    let w = w0;
    while (textWidth(w, px) > TEXT_W) {   // palavra maior que a linha: quebra por caractere
      let k = cps(w).length;
      while (k > 1 && textWidth(slice(w, 0, k), px) > TEXT_W) k--;
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(slice(w, 0, k)); w = slice(w, k); broke = true;
    }
    if (!w) continue;
    const trial = cur ? `${cur} ${w}` : w;
    if (textWidth(trial, px) <= TEXT_W) cur = trial;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return [lines, broke];
}

export type Fit = { text: string; fs: number; truncated: boolean };

// Texto vindo de plugin: a fonte do firmware (Montserrat) não tem setas, ✓ etc. Troca por equivalentes ASCII ou remove, para não aparecer um quadradinho.
const GLYPH_MAP: Record<string, string> = { '↻': '~', '⟳': '~', '→': '>', '←': '<', '↑': '^', '↓': 'v', '•': '*', '…': '...', '✓': 'ok', '✔': 'ok', '✗': 'x', '✘': 'x', '×': 'x' };
export function sanitizeGlyphs(text: string): string {
  let out = '';
  for (const ch of text) { if (/\s/.test(ch) || font.charToGlyph(ch).index !== 0) out += ch; else out += GLYPH_MAP[ch] ?? ''; }
  return out;
}
/** Texto de plugin com quebras de linha explícitas ("node\nOCUPADO"): respeita as quebras (até 2 linhas) e escolhe a maior fonte em que todas as linhas cabem. */
function fitBreaks(text0: string, box: FitBox): Fit {
  const { textW: TEXT_W, maxLines: MAX_LINES, sizes: FONT_SIZES } = box;
  const lines = sanitizeGlyphs(text0).split(/\r?\n/).map((l) => words(l).join(' ')).filter(Boolean).slice(0, MAX_LINES);
  if (!lines.length) return { text: '', fs: FONT_SIZES[0]!, truncated: false };
  if (lines.length === 1) return fitLabel(lines[0]!, false, box);   // uma linha só: quebra normal por palavras
  for (const px of FONT_SIZES) if (lines.every((l) => textWidth(l, px) <= TEXT_W)) return { text: lines.join('\n'), fs: px, truncated: false };
  const px = FONT_SIZES[FONT_SIZES.length - 1]!;
  const out = lines.map((l) => { let x = l; if (textWidth(x, px) <= TEXT_W) return x; while (x && textWidth(x + '...', px) > TEXT_W) x = strip(slice(x, 0, cps(x).length - 1)); return x + '...'; });
  return { text: out.join('\n'), fs: px, truncated: true };
}

export function fitLabel(text0: string, keepBreaks = false, box: FitBox = DEFAULT_BOX): Fit {
  if (keepBreaks) return fitBreaks(text0, box);
  const { textW: TEXT_W, maxLines: MAX_LINES, sizes: FONT_SIZES } = box;
  const text = words(text0).join(' ');
  if (!text) return { text: '', fs: FONT_SIZES[0]!, truncated: false };
  for (const px of FONT_SIZES) {
    const [lines, broke] = wrapWords(text, px, TEXT_W);
    if (lines.length <= MAX_LINES && !broke) return { text: lines.join('\n'), fs: px, truncated: false };
  }
  const px = FONT_SIZES[FONT_SIZES.length - 1]!;
  const lines = wrapWords(text, px, TEXT_W)[0].slice(0, MAX_LINES);
  let last = lines[lines.length - 1]!;
  while (last && textWidth(last + '...', px) > TEXT_W) last = strip(slice(last, 0, cps(last).length - 1));
  lines[lines.length - 1] = last + '...';
  return { text: lines.join('\n'), fs: px, truncated: true };
}

export const HOTKEY_NAMES: Record<string, string> = { cmd: 'Cmd', command: 'Cmd', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', opt: 'Alt', option: 'Alt', shift: 'Shift' };
export const PAGE_OP_NAMES: Record<string, string> = { up: 'Voltar', next: 'Próxima', prev: 'Anterior', home: 'Início', back: 'Voltar' };
export const MEDIA_KEYS: Record<string, string> = { playpause: 'Play/Pausa', next: 'Próxima faixa', prev: 'Faixa anterior', volup: 'Volume +', voldown: 'Volume -', mute: 'Mudo', brightup: 'Brilho +', brightdown: 'Brilho -' };
const MULTI_NAMES: Record<string, string> = { seq: 'Sequência', par: 'Várias ações', cycle: 'Alternar', random: 'Sorteio' };

/** str.title() para as palavras simples usadas em teclas ("pageup" -> "Pageup", "f5" -> "F5"). */
const title = (p: string) => p.replace(/[A-Za-zÀ-ÿ]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());

/** Nome padrão do botão (o texto efetivo) quando o usuário não digitou um. `pageName` resolve o destino de "ir para". */
export function effectiveLabel(b: Button, pageName: (id: number) => string | undefined): string {
  if (b.label) return b.label;
  const a: Action = b.action || ({} as Action);
  if (a.type === 'plugin') return hooks.pluginLabel?.(b) ?? tr('Plugin');
  if (a.type === 'page') {
    if (a.op === 'goto') { const id = Number(a.page); const nm = Number.isInteger(id) ? pageName(id) : undefined; return nm ?? tr('Página?'); }
    return tr(PAGE_OP_NAMES[a.op as string] ?? 'Página');
  }
  const t = a.type;
  if (t === 'url') {
    const u = String(a.url);
    let host = '';
    try { host = new URL(u.includes('//') ? u : '//' + u, 'http://base.invalid').hostname; } catch { host = ''; }
    return (host || u).replace(/^www\./, '');
  }
  if (t === 'text') return tr('Texto');
  if (t === 'folder') return tr('Pasta');
  if (t === 'quitapp') return tr('Fechar {app}', { app: (a.app as string) || 'app' });
  if (t === 'hotkey') return String(a.keys).split('+').map((p) => HOTKEY_NAMES[p] || (cps(p).length === 1 ? p.toUpperCase() : title(p))).join(' ');
  if (t === 'media') return tr(MEDIA_KEYS[a.key as string] ?? 'Mídia');
  if (t === 'webhook') return tr('Webhook');
  if (t === 'homeassistant') return tr('Home Assistant');
  if (t === 'mqtt') return 'MQTT';
  if (t === 'widget') return tr(a.kind === 'weather' ? 'Clima' : a.kind === 'nowplaying' ? 'Tocando agora' : 'Relógio');
  if (t === 'slider') return tr(({ volume: 'Volume', appvolume: 'Volume do app', brightness: 'Brilho', scrub: 'Linha do tempo' } as Record<string, string>)[String(a.mode)] ?? 'Controle');
  if (t === 'resources') return a.res === 'cpu' || a.res === 'gpu' || a.res === 'ram' ? String(a.res).toUpperCase() : tr('Recursos');
  if (t === 'multi') return tr(MULTI_NAMES[(a.mode as string) ?? 'seq'] ?? 'Sequência');
  return (a.app as string) || tr('Vazio');
}

/** Texto que a placa mostra no botão: só o título preenchido pelo usuário (ou o texto que um plugin manda, se o usuário marcou "mostrar texto"). Senão: nada (e sem faixa preta). */
export function displayLabel(b: Button, pageName: (id: number) => string | undefined): string {
  if (DEFAULT_NAMES) return effectiveLabel(b, pageName);
  if (b.label) return b.label;
  return b.action?.type === 'plugin' && b.action.showText === true ? hooks.pluginText?.(b) ?? '' : '';   // texto de plugin: só se o usuário marcou "mostrar texto" na configuração do botão
}

/** Texto do botão já ajustado ao espaço da placa (plugins: preserva as quebras de linha que o plugin pediu, salvo se o usuário digitou um nome). */
export function labelFit(b: Button, pageName: (id: number) => string | undefined, box: FitBox = DEFAULT_BOX): Fit {
  return fitLabel(displayLabel(b, pageName), b.action?.type === 'plugin' && !b.label, box);
}
