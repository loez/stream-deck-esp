// Backup da configuração: UM arquivo .json (botões, páginas, imagens enviadas e ajustes da grade) para guardar ou levar a outro computador.
// Segredos (token do Home Assistant, senha do MQTT, cabeçalho Authorization) ficam FORA por padrão; o usuário escolhe incluí-los. Plugins e modo autônomo não entram (têm instalação/ajustes próprios).
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { UPLOADS } from './env.ts';
import { cleanAction, NO_HOLD, ValueError } from './actions.ts';
import { emptyButton, restride, STRIDE, MAX_PAGES, MAX_SLOTS } from './config.ts';
import type { Action, Button, Config, Page, Store } from './config.ts';

export const BACKUP_FORMAT = 'streamdeck-esp-backup';
const IMG = /^p\d+_b\d+_\d+\.(png|gif)$/;

/** Cópia profunda da ação sem os campos secretos. */
function stripSecrets(a: any): any {
  if (Array.isArray(a)) return a.map(stripSecrets);
  if (!a || typeof a !== 'object') return a;
  const o: Record<string, any> = {};
  for (const [k, v] of Object.entries(a)) {
    if (k === 'token' || k === 'pass') continue;
    if (k === 'headers' && typeof v === 'string') { const h = v.split('\n').filter((l) => !/^\s*(authorization|cookie|x-api-key)\s*:/i.test(l)).join('\n'); if (h) o[k] = h; continue; }
    o[k] = stripSecrets(v);
  }
  return o;
}

export function exportBackup(store: Store, secrets: boolean): Record<string, unknown> {
  const cfg: Config = JSON.parse(JSON.stringify(store.cfg));
  const files: Record<string, string> = {};
  for (const pg of cfg.pages) for (const b of pg.buttons) {
    if (!secrets && b.action) b.action = stripSecrets(b.action);
    if (!secrets && b.alt) b.alt = stripSecrets(b.alt);
    if (b.image && IMG.test(b.image)) { try { files[b.image] = fs.readFileSync(path.join(UPLOADS, b.image)).toString('base64'); } catch { b.image = null; } }
  }
  const { screen: _screen, ...settings } = store.settings;   // a tela é da placa conectada, não do backup
  return { format: BACKUP_FORMAT, version: 1, created: new Date().toISOString(), secrets, settings, config: cfg, files };
}

/** Confere o arquivo e devolve a configuração limpa + as imagens; lança Error com a razão (em português). */
export function parseBackup(raw: unknown, slots: number): { cfg: Config; files: Record<string, Buffer>; settings: Record<string, unknown> } {
  const d = raw as any;
  if (!d || typeof d !== 'object' || d.format !== BACKUP_FORMAT) throw new Error('este arquivo não é um backup do Stream Deck ESP');
  if (d.version !== 1) throw new Error('versão de backup não suportada');
  const c = d.config; if (!c || !Array.isArray(c.pages) || !c.pages.length || c.pages.length > MAX_PAGES * 4) throw new Error('backup sem páginas válidas');
  const files: Record<string, Buffer> = {}; const rawFiles = d.files && typeof d.files === 'object' ? d.files : {};
  for (const [n, v] of Object.entries(rawFiles)) if (IMG.test(n) && typeof v === 'string') files[n] = Buffer.from(v, 'base64');
  const from = Number(c.stride) || 4, ids = new Set<number>(), pages: Page[] = [];
  for (const p of c.pages) {
    if (!p || !Number.isInteger(p.id) || p.id < 1 || ids.has(p.id) || !Array.isArray(p.buttons)) throw new Error('página inválida no backup');
    ids.add(p.id);
    const buttons: Button[] = (from !== STRIDE ? restride(p.buttons, from, STRIDE) : p.buttons).slice(0, MAX_SLOTS).map((b: any): Button => {
      const o = emptyButton();
      if (!b || typeof b !== 'object') return o;
      o.label = typeof b.label === 'string' ? b.label.slice(0, 30) : '';
      o.color = typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : null;
      if (typeof b.image === 'string' && files[b.image]) o.image = b.image;
      if (b.span && Number.isInteger(b.span.c) && Number.isInteger(b.span.r) && b.span.c >= 1 && b.span.r >= 1 && b.span.c <= 8 && b.span.r <= 6) o.span = { c: b.span.c, r: b.span.r };
      if (b.action && typeof b.action === 'object') {
        if (b.action.type === 'plugin') o.action = b.action as Action;   // o host de plugins confere; sem o plugin instalado a ação fica inerte
        else { try { o.action = cleanAction(b.action); } catch (e) { if (!(e instanceof ValueError)) throw e; o.action = null; } }
      }
      if (b.alt && typeof b.alt === 'object' && !NO_HOLD.includes(b.alt.type) && b.alt.type !== 'plugin') { try { const al = cleanAction(b.alt); if (al) o.alt = al; } catch (e) { if (!(e instanceof ValueError)) throw e; } }
      o.imgrev = randomInt(1, 2 ** 30);   // versão nova: o cache de imagens e a placa não confundem com as de antes
      return o;
    });
    while (buttons.length < slots) buttons.push(emptyButton());
    const pg: Page = { id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 20) : `Página ${p.id}`, buttons };
    if (Array.isArray(p.apps)) pg.apps = p.apps.filter((a: any) => a && typeof a.name === 'string' && typeof a.bundle === 'string').slice(0, 10).map((a: any) => ({ name: a.name.slice(0, 100), bundle: a.bundle.slice(0, 200) }));
    if (Number.isInteger(p.parent)) pg.parent = p.parent;
    if (p.autoBack === true) pg.autoBack = true;
    pages.push(pg);
  }
  for (const pg of pages) if (pg.parent !== undefined && !ids.has(pg.parent)) delete pg.parent;
  const cur = ids.has(c.current) ? c.current : pages.find((p) => p.parent === undefined)?.id ?? pages[0]!.id;
  const cfg: Config = { rev: 1, next_id: Math.max(Number(c.next_id) || 0, ...pages.map((p) => p.id + 1)), current: cur, pages, ...(c.autoswitch === false ? { autoswitch: false } : {}), stride: STRIDE };
  return { cfg, files, settings: d.settings && typeof d.settings === 'object' ? d.settings : {} };
}
