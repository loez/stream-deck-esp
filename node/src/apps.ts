// Aplicativos instalados e seus ícones. A parte que depende do sistema (onde ficam os apps, como ler o ícone) está em platform/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE } from './env.ts';
import { platform } from './platform/index.ts';
import type { Action } from './config.ts';

export type AppInfo = { name: string; path: string };
let appsCache: { t: number; list: AppInfo[] } = { t: 0, list: [] };

export function listApps(): AppInfo[] {
  if (Date.now() - appsCache.t < 30_000) return appsCache.list;
  const out = platform.listApps();
  out.sort((a, b) => { const x = a.name.toLowerCase(), y = b.name.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  appsCache = { t: Date.now(), list: out };
  return out;
}

/** Identificador estável do app (bundle id no Mac, nome do .exe no Windows, WM_CLASS no Linux): é o que casa um app com o app em foco. */
export const bundleIdOf = (appPath: string): Promise<string> => platform.appId(appPath);

const isDir = (p: string) => platform.isAppPath(p);

export function appPath(a: Action): string | null {
  if (a.path && isDir(String(a.path))) return String(a.path);
  const want = String(a.app ?? '').toLowerCase();
  return listApps().find((x) => x.name.toLowerCase() === want)?.path ?? null;
}

/** Caminho do PNG do ícone (gera com o JXA se ainda não está no cache). Links simbólicos (ex.: Safari) são resolvidos: senão o ícone ganha a setinha de atalho.
 *  O cache guarda o ícone em 256x256 (o JXA entrega 1024x1024 de 16 bits): o botão usa 44 a 56 px, e decodificar o grande custava ~70 MB de RAM já no primeiro ícone. */
export const ICON_PX = 256;
const iconJobs = new Map<string, Promise<string | null>>();   // geração em andamento por arquivo: pedidos simultâneos do mesmo ícone esperam o mesmo trabalho (antes um apagava o temporário do outro: ENOENT)
export function appIconFile(p: string): Promise<string | null> {
  let real = p; try { real = fs.realpathSync(p); } catch { /* usa o caminho dado */ }
  const f = path.join(CACHE, 'icons', crypto.createHash('sha1').update(real).digest('hex').slice(0, 16) + `_${ICON_PX}.png`);   // o sufixo separa do cache grande do servidor Python (mesma pasta)
  if (fs.existsSync(f)) return Promise.resolve(f);
  let job = iconJobs.get(f);
  if (!job) { job = makeIcon(real, f).finally(() => iconJobs.delete(f)); iconJobs.set(f, job); }
  return job;
}
async function makeIcon(real: string, f: string): Promise<string | null> {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  await platform.extractIcon(real, f);   // cada sistema grava um PNG (até 256 px) em f
  return fs.existsSync(f) ? f : null;
}

/** App instalado pelo bundle id (ex.: o app vinculado a uma página). Procura primeiro nos já conhecidos pelo cache de Info.plist. */
const byBundle = new Map<string, string | null>();
export async function appPathByBundle(bundle: string): Promise<string | null> {
  const want = bundle.toLowerCase(); if (!want) return null;
  if (byBundle.has(want)) { const hit = byBundle.get(want)!; if (hit === null || isDir(hit)) return hit; }
  let found: string | null = null;
  for (const a of listApps()) if ((await bundleIdOf(a.path)).toLowerCase() === want) { found = a.path; break; }
  byBundle.set(want, found); return found;
}
