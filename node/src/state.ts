// Botões com ESTADO: o botão mostra se a coisa está ligada ou desligada. Vale para "Home Assistant" com entidade (luz, tomada, fechadura...) e para o "Mudo" do volume.
// O servidor relê o estado a cada poucos segundos (só da página que está na placa) e, quando muda, o botão é redesenhado: bolinha verde = ligado; cinza + escurecido = desligado; vermelha = mudo.
import { platform } from './platform/index.ts';
import type { Action } from './config.ts';

export type BState = 'on' | 'off' | 'alert';
const ON = new Set(['on', 'open', 'opening', 'unlocked', 'playing', 'heat', 'cool', 'heat_cool', 'auto', 'home', 'active', 'detected']);
const OFF = new Set(['off', 'closed', 'closing', 'locked', 'idle', 'paused', 'standby', 'not_home', 'inactive', 'clear']);
const states = new Map<string, BState | null>();

/** Chave do que o botão acompanha; null = este botão não tem estado. */
export function stateKey(a: Action | null | undefined): string | null {
  if (!a) return null;
  if (a.type === 'homeassistant' && a.entity && a.url && a.token) return `ha|${a.url}|${a.entity}`;
  if (a.type === 'media' && a.key === 'mute' && platform.muted) return 'mute';
  return null;
}
export const stateOf = (a: Action | null | undefined): BState | null => { const k = stateKey(a); return k ? states.get(k) ?? null : null; };
/** Entra na chave do cache de imagens: muda quando o estado muda. */
export const stateTag = (a: Action | null | undefined): string => stateOf(a) ?? '';

async function read(key: string, a: Action): Promise<BState | null> {
  if (key === 'mute') { const m = await platform.muted?.().catch(() => null); return m === null || m === undefined ? null : m ? 'alert' : null; }
  try {
    const r = await fetch(`${a.url}/api/states/${a.entity}`, { headers: { Authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
    const st = String(((await r.json()) as { state?: unknown }).state ?? '').toLowerCase();
    return ON.has(st) ? 'on' : OFF.has(st) ? 'off' : null;
  } catch { return null; }
}
/** Relê o estado de cada botão e devolve as chaves que mudaram. */
export async function stateRefresh(actions: Action[]): Promise<Set<string>> {
  const seen = new Map<string, Action>(); for (const a of actions) { const k = stateKey(a); if (k && !seen.has(k)) seen.set(k, a); }
  const changed = new Set<string>();
  await Promise.all([...seen].map(async ([k, a]) => { const v = await read(k, a); if ((states.get(k) ?? null) !== v) changed.add(k); states.set(k, v); }));
  for (const k of [...states.keys()]) if (!seen.has(k)) states.delete(k);   // botões que saíram da página não ficam guardados
  return changed;
}
