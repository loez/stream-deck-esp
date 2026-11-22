// Modo autônomo: configurações (standalone.json, ao lado do config.json) compartilhadas pelos botões Relógio/Clima e pelo perfil que a placa guarda para funcionar sem o PC.
// Documentação: docs/MODO-AUTONOMO.md.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './env.ts';
import type { Place } from './weather.ts';

export type NightDim = { on: boolean; from: string; to: string; pct: number };   // escurecer entre from e to ("HH:MM"), pct = brilho em %
export type Standalone = {
  enabled: boolean;                 // a placa assume o modo autônomo quando o servidor some
  page: number | null;              // página cujos botões a placa leva (só os que ela executa sozinha)
  tz: string;                       // fuso IANA (ex.: America/Sao_Paulo)
  weather: (Place & { units: 'c' | 'f'; auto?: boolean }) | null;   // auto: cidade detectada pelo IP (aproximada), não escolhida pelo usuário
  locAuto: boolean;                 // tenta detectar a cidade pelo IP enquanto não há cidade (vira false quando o usuário escolhe ou apaga a cidade)
  clock: { h24: boolean; seconds: boolean };
  idleReturnS: number;              // volta ao relógio depois de tantos segundos sem toque
  nightDim: NightDim;
};

export const systemTz = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
export const DEFAULT: Standalone = { enabled: false, page: null, tz: '', weather: null, locAuto: true, clock: { h24: true, seconds: false }, idleReturnS: 20, nightDim: { on: true, from: '22:00', to: '06:00', pct: 15 } };
const file = () => path.join(DATA, 'standalone.json');
const hhmm = (v: unknown, d: string): string => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
const validTz = (v: unknown): string => { const s = String(v ?? '').trim(); if (!s) return ''; try { new Intl.DateTimeFormat('en', { timeZone: s }); return s; } catch { throw new Error('fuso horário inválido'); } };

/** Valida e junta `patch` às configurações atuais (lança Error com a razão em português). */
export function mergeStandalone(cur: Standalone, patch: Record<string, any>): Standalone {
  const o: Standalone = JSON.parse(JSON.stringify(cur));
  if ('enabled' in patch) o.enabled = patch.enabled === true;
  if ('page' in patch) { const p = patch.page === null || patch.page === '' ? null : Number(patch.page); if (p !== null && !Number.isInteger(p)) throw new Error('página inválida'); o.page = p; }
  if ('tz' in patch) o.tz = validTz(patch.tz);
  if ('locAuto' in patch) o.locAuto = patch.locAuto !== false;
  if ('weather' in patch) {
    const w = patch.weather;
    if (w === null) o.weather = null;
    else {
      const lat = Number(w?.lat), lon = Number(w?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('local do clima inválido');
      o.weather = { name: String(w.name ?? '').slice(0, 60), lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000, units: w.units === 'f' ? 'f' : 'c', ...(w.tz ? { tz: String(w.tz).slice(0, 60) } : {}), ...(w.auto === true ? { auto: true } : {}) };
    }
  }
  if (patch.clock && typeof patch.clock === 'object') { if ('h24' in patch.clock) o.clock.h24 = patch.clock.h24 !== false; if ('seconds' in patch.clock) o.clock.seconds = patch.clock.seconds === true; }
  if ('idleReturnS' in patch) { const n = Number(patch.idleReturnS); if (!Number.isFinite(n)) throw new Error('tempo inválido'); o.idleReturnS = Math.max(5, Math.min(600, Math.round(n))); }
  if (patch.nightDim && typeof patch.nightDim === 'object') {
    const n = patch.nightDim; if ('on' in n) o.nightDim.on = n.on === true;
    if ('from' in n) o.nightDim.from = hhmm(n.from, o.nightDim.from); if ('to' in n) o.nightDim.to = hhmm(n.to, o.nightDim.to);
    if ('pct' in n) o.nightDim.pct = Math.max(0, Math.min(100, Math.round(Number(n.pct) || 0)));
  }
  return o;
}

let cur: Standalone | null = null;
export function getStandalone(): Standalone {
  if (cur) return cur;
  try { cur = mergeStandalone(DEFAULT, JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch { cur = JSON.parse(JSON.stringify(DEFAULT)) as Standalone; }
  return cur;
}
export function setStandalone(patch: Record<string, any>, auto = false): Standalone {
  if (!auto && 'weather' in patch && !('locAuto' in patch) && !patch.weather?.auto) patch = { ...patch, locAuto: false };   // o usuário escolheu (ou apagou) a cidade: a detecção pelo IP não mexe mais nela
  const next = mergeStandalone(getStandalone(), patch); cur = next;
  try { fs.writeFileSync(file(), JSON.stringify(next, null, 1), { mode: 0o600 }); } catch { /* vale até reiniciar */ }
  return next;
}
/** Fuso em uso: o escolhido ou o do sistema. */
export const tzOf = (s: Standalone = getStandalone()): string => s.tz || systemTz();
export function resetStandaloneCache(): void { cur = null; }
