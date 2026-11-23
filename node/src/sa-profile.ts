// Perfil autônomo: o que a placa guarda na flash para funcionar sem o PC (docs/MODO-AUTONOMO.md).
// Montado a partir da página escolhida em standalone.ts: geometria, botões (imagem pronta + descritor de execução `ex` só para o que a placa consegue fazer sozinha) e ícones do clima.
// ATENÇÃO: o perfil leva segredos (tokens, senhas de MQTT): só sai em GET /api/sa (token da placa ou cabo), nunca em /api/deck.
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import type { Store } from './config.ts';
import { labelFit } from './fit.ts';
import { OFFLINE_TYPES } from './netactions.ts';
import { getStandalone, tzOf } from './standalone.ts';
import { WEATHER_KINDS, weatherIcon } from './weather.ts';
import { getLang, tr } from './i18n.ts';

// ---------- fuso horário: IANA -> POSIX TZ (a placa não tem o banco de fusos; o POSIX TZ leva as regras de horário de verão) ----------
const NY = 'EST5EDT,M3.2.0,M11.1.0', CHI = 'CST6CDT,M3.2.0,M11.1.0', DEN = 'MST7MDT,M3.2.0,M11.1.0', LA = 'PST8PDT,M3.2.0,M11.1.0', CET = 'CET-1CEST,M3.5.0,M10.5.0/3', EET = 'EET-2EEST,M3.5.0/3,M10.5.0/4', AUE = 'AEST-10AEDT,M10.1.0,M4.1.0/3';
export const POSIX_TZ: Record<string, string> = {
  UTC: 'UTC0', 'Etc/UTC': 'UTC0',
  'America/Sao_Paulo': '<-03>3', 'America/Bahia': '<-03>3', 'America/Fortaleza': '<-03>3', 'America/Recife': '<-03>3', 'America/Belem': '<-03>3', 'America/Maceio': '<-03>3', 'America/Araguaina': '<-03>3', 'America/Manaus': '<-04>4', 'America/Cuiaba': '<-04>4', 'America/Campo_Grande': '<-04>4', 'America/Porto_Velho': '<-04>4', 'America/Rio_Branco': '<-05>5', 'America/Noronha': '<-02>2',
  'America/Argentina/Buenos_Aires': '<-03>3', 'America/Montevideo': '<-03>3', 'America/Santiago': '<-04>4<-03>,M9.1.6/24,M4.1.6/24', 'America/Asuncion': '<-03>3', 'America/La_Paz': '<-04>4', 'America/Bogota': '<-05>5', 'America/Lima': '<-05>5', 'America/Guayaquil': '<-05>5', 'America/Caracas': '<-04>4',
  'America/Mexico_City': 'CST6', 'America/Monterrey': 'CST6', 'America/Guatemala': 'CST6', 'America/Panama': 'EST5', 'America/Havana': 'CST5CDT,M3.2.0/0,M11.1.0/1', 'America/Puerto_Rico': 'AST4',
  'America/New_York': NY, 'America/Toronto': NY, 'America/Detroit': NY, 'America/Chicago': CHI, 'America/Winnipeg': CHI, 'America/Denver': DEN, 'America/Edmonton': DEN, 'America/Phoenix': 'MST7', 'America/Los_Angeles': LA, 'America/Vancouver': LA,
  'America/Anchorage': 'AKST9AKDT,M3.2.0,M11.1.0', 'America/Halifax': 'AST4ADT,M3.2.0,M11.1.0', 'America/St_Johns': 'NST3:30NDT,M3.2.0,M11.1.0', 'Pacific/Honolulu': 'HST10',
  'Europe/London': 'GMT0BST,M3.5.0/1,M10.5.0', 'Europe/Dublin': 'GMT0IST,M3.5.0/1,M10.5.0', 'Europe/Lisbon': 'WET0WEST,M3.5.0/1,M10.5.0', 'Atlantic/Reykjavik': 'GMT0', 'Atlantic/Azores': '<-01>1<+00>,M3.5.0/0,M10.5.0/1',
  'Europe/Paris': CET, 'Europe/Berlin': CET, 'Europe/Madrid': CET, 'Europe/Rome': CET, 'Europe/Amsterdam': CET, 'Europe/Brussels': CET, 'Europe/Vienna': CET, 'Europe/Zurich': CET, 'Europe/Stockholm': CET, 'Europe/Oslo': CET, 'Europe/Copenhagen': CET, 'Europe/Warsaw': CET, 'Europe/Prague': CET, 'Europe/Budapest': CET,
  'Europe/Athens': EET, 'Europe/Helsinki': EET, 'Europe/Kiev': EET, 'Europe/Kyiv': EET, 'Europe/Bucharest': EET, 'Europe/Sofia': EET, 'Europe/Moscow': 'MSK-3', 'Europe/Istanbul': '<+03>-3',
  'Asia/Tokyo': 'JST-9', 'Asia/Seoul': 'KST-9', 'Asia/Shanghai': 'CST-8', 'Asia/Hong_Kong': 'HKT-8', 'Asia/Taipei': 'CST-8', 'Asia/Singapore': '<+08>-8', 'Asia/Manila': 'PST-8', 'Asia/Kolkata': 'IST-5:30', 'Asia/Calcutta': 'IST-5:30', 'Asia/Dubai': '<+04>-4',
  'Asia/Bangkok': '<+07>-7', 'Asia/Jakarta': 'WIB-7', 'Asia/Karachi': 'PKT-5', 'Asia/Dhaka': '<+06>-6', 'Asia/Tehran': '<+0330>-3:30', 'Asia/Riyadh': '<+03>-3', 'Asia/Kathmandu': '<+0545>-5:45', 'Asia/Jerusalem': 'IST-2IDT,M3.4.4/26,M10.5.0',
  'Africa/Cairo': 'EET-2EEST,M4.5.5/0,M10.5.4/24', 'Africa/Johannesburg': 'SAST-2', 'Africa/Lagos': 'WAT-1', 'Africa/Nairobi': 'EAT-3', 'Africa/Casablanca': '<+01>-1', 'Africa/Algiers': 'CET-1',
  'Australia/Sydney': AUE, 'Australia/Melbourne': AUE, 'Australia/Hobart': AUE, 'Australia/Brisbane': 'AEST-10', 'Australia/Perth': 'AWST-8', 'Australia/Adelaide': 'ACST-9:30ACDT,M10.1.0,M4.1.0/3', 'Australia/Darwin': 'ACST-9:30', 'Pacific/Auckland': 'NZST-12NZDT,M9.5.0,M4.1.0/3',
};
/** POSIX TZ de um fuso IANA: da tabela; fora dela, o deslocamento de agora (sem horário de verão). */
export function posixTz(iana: string): string {
  if (POSIX_TZ[iana]) return POSIX_TZ[iana]!;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: iana, timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(parts); if (!m) return 'UTC0';
    const h = Number(m[2]), mm = Number(m[3] ?? 0), sign = m[1] === '+' ? '-' : '', name = `<${m[1]}${String(h).padStart(2, '0')}${mm ? String(mm).padStart(2, '0') : ''}>`;
    return `${name}${sign}${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
  } catch { return 'UTC0'; }
}

// ---------- perfil ----------
export type SaTile = { i: number; x: number; y: number; w: number; h: number; bar: number; label: string; fs: number; img: number; wd?: string; ex?: Record<string, unknown> };
export type SaProfile = {
  v: number; rev: string; tz: string; tzName: string; lang: string;
  clock: { h24: boolean; seconds: boolean }; idle: number; night: { on: boolean; from: string; to: string; pct: number };
  weather: { lat: number; lon: number; units: string; name: string } | null; icons: string[];
  geom: { cols: number; rows: number; font: number; top: number; w: number; h: number; bar: number }; page: string; tiles: SaTile[];
  tx: Record<string, string>;   // textos que a placa mostra, já no idioma do app
};
const EX_FIELDS: Record<string, string[]> = { webhook: ['url', 'method', 'body', 'ctype', 'headers'], homeassistant: ['url', 'token', 'domain', 'service', 'entity', 'data'], mqtt: ['host', 'port', 'tls', 'user', 'pass', 'topic', 'payload', 'retain'] };

/** Perfil da página escolhida (null se o modo autônomo está desligado, sem página, ou a página não existe mais). */
export function buildProfile(store: Store): SaProfile | null {
  const s = getStandalone(); if (!s.enabled || s.page === null) return null;
  const pg = store.getPage(s.page); if (!pg) return null;
  const g = store.geom, pageName = (id: number) => store.getPage(id)?.name;
  const tiles: SaTile[] = store.tiles(pg.id).map((t) => {
    const bt = pg.buttons[t.slot]!, tb = store.tileBox(t.c, t.r), f = labelFit(bt, pageName, tb), a = bt.action as Record<string, any> | null;
    const o: SaTile = { i: t.i, x: t.x, y: t.y, w: t.w, h: t.h, bar: tb.bar, label: f.text, fs: f.fs, img: bt.imgrev };
    if (a?.type === 'widget' && a.kind !== 'nowplaying' && a.kind !== 'notifications') o.wd = String(a.kind);   // "Tocando agora" precisa do computador: na placa sozinha o botão fica sem imagem própria
    else if (a && OFFLINE_TYPES.includes(a.type)) { const ex: Record<string, unknown> = { k: a.type }; for (const k of EX_FIELDS[a.type]!) if (a[k] !== undefined && a[k] !== '' && a[k] !== false) ex[k] = a[k]; o.ex = ex; }
    return o;
  });
  const tz = tzOf(s), w = s.weather;
  const p: Omit<SaProfile, 'rev'> = {
    v: 1, tz: posixTz(tz), tzName: tz, lang: getLang(), clock: { ...s.clock }, idle: s.idleReturnS, night: { ...s.nightDim },
    weather: w ? { lat: w.lat, lon: w.lon, units: w.units, name: w.name } : null, icons: [...WEATHER_KINDS],
    geom: { cols: g.cols, rows: g.rows, font: g.font, top: g.top, w: g.w, h: g.h, bar: g.bar }, page: pg.name, tiles,
    tx: { auto: tr('Modo autônomo'), touch: tr('Toque para ver os botões'), needpc: tr('precisa do computador'), nodata: tr('sem dados'), sent: tr('enviado'),
      sun: tr('Céu limpo'), moon: tr('Céu limpo'), partly: tr('Parcialmente nublado'), cloud: tr('Nublado'), fog: tr('Neblina'), rain: tr('Chuva'), storm: tr('Tempestade'), snow: tr('Neve') },
  };
  const rev = crypto.createHash('sha1').update(JSON.stringify(p)).digest('hex').slice(0, 12);
  return { ...p, rev };
}

/** Revisão do perfil para o /api/deck ("0" = sem perfil: a placa apaga o que guardou). Memoizada por quem chama. */
export const profileRev = (store: Store): string => buildProfile(store)?.rev ?? '0';

/** Ícone do clima em RGB565 sobre o fundo escuro (a placa não tem canal alfa), `size` x `size`. */
export function iconCanvas(kind: string, size = 48): Canvas | null {
  if (!(WEATHER_KINDS as string[]).includes(kind)) return null;
  const cv = createCanvas(size, size), c = cv.getContext('2d'); c.fillStyle = '#16161a'; c.fillRect(0, 0, size, size);
  c.drawImage(weatherIcon(kind as any, size), 0, 0); return cv;
}
/** Quais botões da página escolhida funcionam sem o PC (para a página mostrar ✓/✗). */
export function offlineReport(store: Store): { slot: number; label: string; ok: boolean; kind: string }[] {
  const s = getStandalone(), pg = s.page === null ? null : store.getPage(s.page); if (!pg) return [];
  const pageName = (id: number) => store.getPage(id)?.name;
  return store.tiles(pg.id).map((t) => { const bt = pg.buttons[t.slot]!, a = bt.action as Record<string, any> | null, f = labelFit(bt, pageName, store.tileBox(t.c, t.r));
    return { slot: t.slot, label: f.text.replace(/\n/g, ' ') || (a?.type ?? ''), kind: String(a?.type ?? ''), ok: !!a && ((a.type === 'widget' && a.kind !== 'nowplaying' && a.kind !== 'notifications') || OFFLINE_TYPES.includes(a.type)) }; }).filter((x) => x.kind);
}
