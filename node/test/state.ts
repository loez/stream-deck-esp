// Teste dos botões com estado (state.ts + bolinha no render): Home Assistant falso (ligado/desligado/indisponível/token errado) e o "Mudo" com platform.muted trocado.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platform } from '../src/platform/index.ts';
import { Store } from '../src/config.ts';
import { renderButton } from '../src/render.ts';
import { stateKey, stateOf, stateRefresh, stateTag } from '../src/state.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
let haState = 'off', hits = 0; const auth: string[] = [];
const ha = http.createServer((q, r) => {
  hits++; auth.push(String(q.headers.authorization));
  if (q.headers.authorization !== 'Bearer tok') { r.writeHead(401); return r.end('{}'); }
  r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ entity_id: 'light.sala', state: haState }));
});
const px = (cv: any, x: number, y: number) => Array.from(cv.getContext('2d').getImageData(x, y, 1, 1).data) as number[];

async function main() {
  await new Promise<void>((r) => ha.listen(8953, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-st-')), store = new Store(path.join(tmp, 'c.json'), path.join(tmp, 's.json'));
  const act = { type: 'homeassistant', url: 'http://127.0.0.1:8953', token: 'tok', domain: 'light', service: 'toggle', entity: 'light.sala' };
  store.getButton(1, 0)!.action = act; store.getButton(1, 0)!.color = '#3366cc';

  console.log('== quem tem estado');
  check(stateKey(act) === 'ha|http://127.0.0.1:8953|light.sala', 'HA com entidade tem estado');
  check(stateKey({ ...act, entity: undefined }) === null && stateKey({ type: 'hotkey' }) === null && stateKey(null) === null, 'sem entidade / outros tipos: sem estado');

  console.log('\n== Home Assistant');
  const base = await renderButton(store, 1, 0), W = base.width, corner = (cv: any) => px(cv, W - 7, 7);
  const c0 = corner(base);
  let ch = await stateRefresh([act]); check(ch.size === 1 && stateOf(act) === 'off' && stateTag(act) === 'off', 'desligado lido', stateTag(act));
  const off = await renderButton(store, 1, 0); check(corner(off).join() !== c0.join() && px(off, 10, 40)[0]! < px(base, 10, 40)[0]!, 'desligado: bolinha cinza e imagem escurecida');
  check(auth.every((a) => a === 'Bearer tok'), 'envia o token como Bearer');
  ch = await stateRefresh([act]); check(ch.size === 0, 'sem mudança: nada a redesenhar');
  haState = 'on'; ch = await stateRefresh([act]); check(ch.size === 1 && stateOf(act) === 'on', 'ligado lido (mudou)');
  const on = await renderButton(store, 1, 0), g = corner(on); check(g[1]! > g[0]! && g[1]! > 150, 'ligado: bolinha verde', JSON.stringify(g));
  haState = 'unavailable'; await stateRefresh([act]); check(stateOf(act) === null && corner(await renderButton(store, 1, 0)).join() === c0.join(), 'indisponível: sem marca');
  await stateRefresh([{ ...act, token: 'errado' }]); check(stateOf({ ...act, token: 'errado' }) === null, 'token recusado (401): sem marca, sem erro');
  const down = { ...act, url: 'http://127.0.0.1:1' }; await stateRefresh([down]); check(stateOf(down) === null, 'servidor fora do ar: sem marca, sem erro');

  console.log('\n== mudo');
  let muted: boolean | null = false; (platform as any).muted = async () => muted;
  const mute = { type: 'media', key: 'mute' }; store.getButton(1, 1)!.action = mute;
  await stateRefresh([mute]); check(stateKey(mute) === 'mute' && stateOf(mute) === null, 'som ligado: sem marca');
  muted = true; ch = await stateRefresh([mute]); const r = corner(await renderButton(store, 1, 1)); check(ch.size === 1 && stateOf(mute) === 'alert' && r[0]! > 200 && r[1]! < 120, 'mudo: bolinha vermelha', JSON.stringify(r));
  muted = null; await stateRefresh([mute]); check(stateOf(mute) === null, 'leitura falhou: sem marca');

  console.log('\n== limpeza');
  await stateRefresh([]); check(stateOf(act) === null, 'botões que saíram da página são esquecidos');
  fs.rmSync(tmp, { recursive: true, force: true });
}
main().then(() => { ha.close(); console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0); }).catch((e) => { ha.close(); console.error(e); process.exit(1); });
