// Monitor de Recursos: uso de CPU, RAM e GPU do computador (GET /api/resources; usado pelo plugin "Monitor de Recursos").
// CPU e RAM vêm do módulo os do Node (igual em todos os sistemas); a GPU e a RAM "de verdade" vêm de platform.resources().
import os from 'node:os';
import { platform } from './platform/index.ts';

export type Resources = { cpu: number | null; ram: { percent: number; usedGB: number; totalGB: number }; gpu: number | null };

const times = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
let prev = times(), cpu: number | null = null, at = 0, inflight: Promise<Resources> | null = null, last: Resources | null = null;
const GB = 1024 ** 3, round1 = (n: number) => Math.round(n * 10) / 10;

/** Leitura atual (cache de 1,5 s: vários botões/páginas pedindo juntos custam uma leitura só). A CPU é a média desde a leitura anterior; a primeira fica null. */
export function readResources(): Promise<Resources> {
  const now = Date.now();
  if (last && now - at < 1500) return Promise.resolve(last);
  inflight ??= (async () => {
    try {
      const t = times(), dt = t.total - prev.total;
      if (dt > 0 && now - at > 200) { cpu = Math.min(100, Math.max(0, Math.round(100 * (1 - (t.idle - prev.idle) / dt)))); prev = t; }
      const extra = await platform.resources().catch(() => ({ gpu: null, ramUsed: null }));
      const total = os.totalmem(), used = extra.ramUsed ?? total - os.freemem();
      last = { cpu, ram: { percent: Math.round(100 * used / total), usedGB: round1(used / GB), totalGB: round1(total / GB) }, gpu: extra.gpu === null ? null : Math.round(extra.gpu) };
      at = Date.now(); return last;
    } finally { inflight = null; }
  })();
  return inflight;
}

/** Leitura mais recente (sem consultar o sistema); null antes da primeira. */
export const lastResources = (): Resources | null => last;
export const RES_KINDS = ['cpu', 'gpu', 'ram', 'all'] as const;
export type ResKind = typeof RES_KINDS[number];
/** O que o botão mostra agora, em texto (muda só quando a imagem muda): serve de chave de cache. */
export function resKey(kind: string, r: Resources | null = last): string {
  if (!r) return '-';
  return kind === 'cpu' ? String(r.cpu) : kind === 'gpu' ? String(r.gpu) : kind === 'ram' ? String(r.ram.percent) : `${r.cpu}|${r.gpu}|${r.ram.percent}`;
}
/** Versão do ícone de cada botão de recursos ("pagina:slot" -> n): o servidor soma 1 quando o valor mostrado muda (invalida o cache de imagens e recarrega a prévia). */
export const resVer = new Map<string, number>();
