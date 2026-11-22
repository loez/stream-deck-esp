// Grade (colunas x linhas) e tamanho da fonte do nome dos botões, escolhidos na página de configuração (settings.json).
// Daqui sai a geometria que o servidor e a placa usam: tamanho do botão, altura da faixa do nome, largura útil do texto e tamanhos de fonte tentados.
// A grade padrão (4x2, fonte 12) dá exatamente os valores antigos: botão 73x84, faixa de 32 px, texto de 66 px, fontes 12/11/10.
import fs from 'node:fs';
import { SETTINGS_FILE, DEFAULT_NAMES } from './env.ts';
import { metrics } from './fit.ts';
import type { FitBox } from './fit.ts';
import { isLang } from './i18n.ts';
import type { Lang } from './i18n.ts';


// Geometria a partir do tamanho (e da densidade) da tela da placa, que a própria placa informa em /api/deck?w=&h=&ppi=. Sem essa informação (firmware antigo) assume a ES3C28P: 320x240, 143 ppi.
// A grade vai da faixa de status (y=36) até 5 px do fim da tela; sem a faixa começa em y=5. Na ES3C28P isso dá a altura de 199 px (230 sem a faixa) de sempre.
// DECK_GRID_H=174 reproduz o layout antigo (com aviso embaixo, só em 320x240): só o teste de paridade com o servidor Python usa; modo legado também usa STRIDE 4 e máximo 4x4.
export const MARGIN_X = 5, GAP = 6, TOP_STATUS = 36, TOP_FULL = 5, BOTTOM = 5;
const LEGACY_GRID_H = Number(process.env.DECK_GRID_H || 0);
export const STRIDE = DEFAULT_NAMES ? 4 : 8;                          // colunas da grade virtual onde as páginas guardam os botões (slot = linha*STRIDE + coluna)
export const MAX_COLS = DEFAULT_NAMES ? 4 : 8, MAX_ROWS = DEFAULT_NAMES ? 4 : 6;   // tetos do formato (o que cabe de fato depende da tela: limitsFor)
export const MAX_SLOTS = STRIDE * MAX_ROWS;
export const MIN_FONT = 10;
export const MIN_BTN_MM = { w: 12, h: 7.5 };                          // botão menor que isto o dedo não acerta (4x4 na ES3C28P de 2,8" = 13 x 8 mm)

export type Screen = { w: number; h: number; ppi: number };            // pixels da tela e pixels por polegada
export const DEFAULT_SCREEN: Screen = { w: 320, h: 240, ppi: 143 };

export type Settings = { cols: number; rows: number; font: number; status: boolean; screen: Screen; lang?: Lang };   // status: faixa de status (Mac conectado, nome da página) no topo da placa
export const DEFAULT_SETTINGS: Settings = { cols: 4, rows: 2, font: 12, status: true, screen: DEFAULT_SCREEN };

/** Valores plausíveis de uma tela informada pela placa (ou null). */
export function parseScreen(w: unknown, h: unknown, ppi: unknown): Screen | null {
  const W = Number(w), H = Number(h), P = Number(ppi);
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 120 || W > 2048 || H < 120 || H > 2048) return null;
  return { w: W, h: H, ppi: Number.isFinite(P) && P >= 60 && P <= 450 ? Math.round(P) : DEFAULT_SCREEN.ppi };
}

/** O que a tela comporta: colunas/linhas até onde o botão ainda tem o tamanho mínimo para o dedo, e a faixa de fontes (em px, proporcional à densidade). */
export function limitsFor(sc: Screen) {
  const minW = MIN_BTN_MM.w * sc.ppi / 25.4, minH = MIN_BTN_MM.h * sc.ppi / 25.4;
  const fit = (room: number, min: number, max: number) => Math.max(2, Math.min(max, Math.floor((room + GAP) / (min + GAP))));
  const k = sc.ppi / DEFAULT_SCREEN.ppi;
  return {
    cols: [2, fit(sc.w - 2 * MARGIN_X, minW, MAX_COLS)] as [number, number],
    rows: [2, fit(sc.h - TOP_STATUS - BOTTOM, minH, MAX_ROWS)] as [number, number],
    font: [MIN_FONT, Math.min(24, Math.max(MIN_FONT + 2, Math.round(16 * k)))] as [number, number],
  };
}
export type Limits = ReturnType<typeof limitsFor>;

export type Geom = {
  cols: number; rows: number; count: number;   // botões visíveis
  top: number;                                 // y do primeiro botão (36 com a faixa de status, 5 sem ela)
  w: number; h: number;                        // tamanho de cada botão (px)
  font: number; lines: number; bar: number;    // fonte preferida, linhas do nome e altura da faixa do nome (px)
} & FitBox;

const inRange = (v: unknown, [lo, hi]: readonly [number, number] | readonly number[]): v is number => Number.isInteger(v) && (v as number) >= lo! && (v as number) <= hi!;

/** Valida um pedido (campos que faltam ficam como estão; a tela não é editável por aqui: vem da placa). Devolve o erro em português, ou os valores. */
export function parseSettings(d: any, cur: Settings): Settings | string {
  const out = { ...cur }, lim = limitsFor(cur.screen);
  if ('status' in d) { if (typeof d.status !== 'boolean') return 'faixa de status: verdadeiro ou falso'; out.status = d.status; }
  if ('lang' in d) { if (!isLang(d.lang)) return 'idioma inválido'; out.lang = d.lang; }
  for (const k of ['cols', 'rows', 'font'] as const) {
    if (!(k in d)) continue;
    if (!inRange(d[k], lim[k])) return `${k === 'cols' ? 'colunas' : k === 'rows' ? 'linhas' : 'fonte'}: valor entre ${lim[k][0]} e ${lim[k][1]}`;
    out[k] = d[k];
  }
  return out;
}

export function loadSettings(file: string = SETTINGS_FILE): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')), screen = parseScreen(raw?.screen?.w, raw?.screen?.h, raw?.screen?.ppi) ?? DEFAULT_SCREEN;
    const r = parseSettings(raw, { ...DEFAULT_SETTINGS, screen });
    return typeof r === 'string' ? { ...DEFAULT_SETTINGS, screen } : r;
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s: Settings, file: string = SETTINGS_FILE): void {
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, file);
}

export function geometry(s0: Settings): Geom {
  const lim = limitsFor(s0.screen), s = { ...s0, cols: Math.min(s0.cols, lim.cols[1]), rows: Math.min(s0.rows, lim.rows[1]), font: Math.min(Math.max(s0.font, lim.font[0]), lim.font[1]) };   // se a tela mudou, a escolha antiga é ajustada ao que cabe
  const sc = s.screen, top = s.status ? TOP_STATUS : TOP_FULL;
  const gridH = LEGACY_GRID_H && sc.h === 240 ? LEGACY_GRID_H + (TOP_STATUS - top) : sc.h - top - BOTTOM;
  const w = Math.floor((sc.w - 2 * MARGIN_X - (s.cols - 1) * GAP) / s.cols), h = Math.floor((gridH - (s.rows - 1) * GAP) / s.rows);
  const [asc, desc] = metrics(s.font), lh = asc + desc;
  const lines = h - 2 * lh >= 36 ? 2 : 1;   // 2 linhas só se sobrar espaço para um ícone de pelo menos 36 px acima da faixa
  const sizes: number[] = []; for (let px = s.font; px >= MIN_FONT; px--) sizes.push(px);
  return { cols: s.cols, rows: s.rows, count: s.cols * s.rows, top, w, h, font: s.font, lines, bar: lines * lh, textW: w - 7, maxLines: lines, sizes };
}

/** Medidas de um botão que ocupa `c` colunas x `r` linhas da grade (tile): maior botão, mais texto cabe e a faixa do nome acompanha a altura. 1x1 devolve a própria geometria. */
export function tileBox(g: Geom, c: number, r: number): Geom {
  if (c <= 1 && r <= 1) return g;
  const w = c * g.w + (c - 1) * GAP, h = r * g.h + (r - 1) * GAP, [asc, desc] = metrics(g.font), lh = asc + desc;
  const lines = h - 2 * lh >= 36 ? 2 : 1;
  return { ...g, w, h, lines, bar: lines * lh, textW: w - 7, maxLines: lines };
}

/** Slots que cada página guarda para esta grade (STRIDE colunas virtuais x linhas). */
export const slotCount = (s: Settings): number => STRIDE * s.rows;
/** Índice do botão na placa -> slot da página (a grade virtual tem sempre STRIDE colunas). */
export const slotOf = (i: number, cols: number): number => Math.floor(i / cols) * STRIDE + (i % cols);
