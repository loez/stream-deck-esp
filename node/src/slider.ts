// Controles deslizantes: um botão (normalmente juntado, ex.: 3x1 ou 1x3) em que se arrasta o dedo. A placa manda a posição do dedo (0-1000 ao longo do botão) em POST /api/slide/N?v=&p=
// (p: 0 = encostou, 1 = arrastando, 2 = soltou) e o servidor traduz conforme o modo:
//   volume     absoluto: posição = volume geral do sistema            appvolume  absoluto: volume do Spotify / Apple Music
//   brightness relativo: arrastar = passos de brilho (teclas de brilho) scrub      relativo: arrastar = passos de uma tecla (ex.: ← → para andar quadro a quadro numa linha do tempo)
// Absoluto: a placa desenha o preenchimento sozinha (resposta imediata) e o servidor mantém `level` (lido do sistema a cada poucos segundos). Relativo: só conta o quanto o dedo andou.
import { platform } from './platform/index.ts';
import type { Platform } from './platform/index.ts';
import { parseHotkey } from './actions.ts';

export const SLIDER_MODES = ['volume', 'appvolume', 'brightness', 'scrub'] as const;
export type SliderMode = typeof SLIDER_MODES[number];
export const SLIDER_APPS = ['spotify', 'music'] as const;
export type SliderAct = { mode: SliderMode; app?: string; axis?: string; dec?: string; inc?: string; sens?: number };
export type Sys = Pick<Platform, 'volumeGet' | 'volumeSet' | 'appVolumeGet' | 'appVolumeSet' | 'media' | 'hotkey'>;

export const isAbsolute = (a: object): boolean => { const m = (a as { mode?: unknown }).mode; return m === 'volume' || m === 'appvolume'; };
/** Cor do preenchimento/indicador (RGB 0xRRGGBB): igual na prévia e na placa. */
export function sliderColor(a: SliderAct): number { return a.mode === 'volume' ? 0x19d9c8 : a.mode === 'appvolume' ? (a.app === 'music' ? 0xfa2d48 : 0x1db954) : a.mode === 'brightness' ? 0xfbbf24 : 0xa78bfa; }
/** Orientação: 'h' (esquerda→direita) ou 'v' (baixo→cima); no automático, pelo formato do botão (mais largo que alto = horizontal). */
export function sliderAxis(a: object, c: number, r: number): 'h' | 'v' { const x = (a as { axis?: unknown }).axis; return x === 'h' || x === 'v' ? x : c >= r ? 'h' : 'v'; }

type St = { level: number; target: number; busy: boolean; dirty: boolean; touchAt: number; last: number; acc: number; pend: number; err: string };
const S = new Map<string, St>();
const st = (k: string): St => { let s = S.get(k); if (!s) { s = { level: 0, target: 0, busy: false, dirty: false, touchAt: 0, last: 0, acc: 0, pend: 0, err: '' }; S.set(k, s); } return s; };
/** Versão do que a prévia mostra de cada slider ("pagina:slot" -> n): sobe quando o nível muda (a página recarrega só essa prévia). */
export const sliderVer = new Map<string, number>();
const bump = (k: string) => sliderVer.set(k, (sliderVer.get(k) ?? 0) + 1);
export const levelOf = (k: string): number => S.get(k)?.level ?? 0;
export const forget = (): void => { S.clear(); sliderVer.clear(); };

/** Relê o nível do sistema (só modos absolutos e fora de um arrasto): o volume pode ter mudado por outro lado (teclas, outro app). */
export async function refreshLevel(k: string, a: SliderAct, sys: Sys = platform): Promise<void> {
  if (!isAbsolute(a)) return;
  const s = st(k); if (Date.now() - s.touchAt < 2000 || s.busy) return;
  const v = a.mode === 'volume' ? await sys.volumeGet() : await sys.appVolumeGet(String(a.app ?? 'spotify'));
  if (v === null || Date.now() - s.touchAt < 2000) return;
  const lv = Math.round(v * 10);
  if (Math.abs(lv - s.level) >= 5) { s.level = lv; bump(k); }
}

async function applyAbsolute(k: string, a: SliderAct, sys: Sys): Promise<void> {
  const s = st(k); if (s.busy) { s.dirty = true; return; }   // já tem uma chamada em andamento: ao terminar, aplica o valor mais recente (não empilha)
  s.busy = true;
  try { do { s.dirty = false; const pct = Math.round(s.target / 10); if (a.mode === 'volume') { s.err = (await sys.volumeSet(pct)) ? '' : 'sem controle de volume'; } else { const r = await sys.appVolumeSet(String(a.app ?? 'spotify'), pct); s.err = r[0] ? '' : r[1]; } } while (s.dirty); }
  finally { s.busy = false; }
}
async function runSteps(k: string, a: SliderAct, sys: Sys): Promise<void> {
  const s = st(k); if (s.busy) return;   // o laço já está rodando e consome s.pend
  s.busy = true;
  try {
    while (s.pend !== 0) {
      const dir = s.pend > 0 ? 1 : -1; s.pend -= dir;
      if (a.mode === 'brightness') { const [ok, m] = await sys.media(dir > 0 ? 'brightup' : 'brightdown'); s.err = ok ? '' : m; }
      else { const [mods, key] = parseHotkey(dir > 0 ? a.inc || 'right' : a.dec || 'left'); const [ok, m] = await sys.hotkey(mods, key); s.err = ok ? '' : m; }
    }
  } finally { s.busy = false; }
}

/** Evento de arrasto da placa. v = posição do dedo ao longo do botão (0-1000; esquerda→direita ou baixo→cima); phase 0/1/2. Devolve o nível atual (permille) e o último erro, se houver. */
export function slide(k: string, a: SliderAct, v: number, phase: number, sys: Sys = platform): { level: number; err: string } {
  const s = st(k), pos = Math.max(0, Math.min(1000, Math.round(v))), now = Date.now(); s.touchAt = now;
  if (isAbsolute(a)) {
    if (s.level !== pos) { s.level = pos; bump(k); }
    s.target = pos; void applyAbsolute(k, a, sys);
  } else {
    if (phase === 0) { s.last = pos; s.acc = 0; }
    else {
      const sens = Math.max(4, Math.min(80, Number(a.sens) || 24));   // passos para o arrasto do botão inteiro
      s.acc += (pos - s.last) * sens / 1000; s.last = pos;
      const n = Math.trunc(s.acc); s.acc -= n;
      if (n !== 0) { s.pend = Math.max(-30, Math.min(30, s.pend + n)); void runSteps(k, a, sys); }
    }
  }
  return { level: s.level, err: s.err };
}
