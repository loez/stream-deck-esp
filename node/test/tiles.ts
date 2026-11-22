// Botões juntados ("tiles"): juntar/separar, validações, /api/deck com e sem a capacidade da placa, imagens e toques por botão, mover/trocar. Pastas temporárias, porta 8808, sem mDNS/plugins.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tiles-')), DATA = path.join(TMP, 'data'), PORT = 8808, TOKEN = 'tiles-test-token-0123456789abcdefghi';
const BOARD = { 'User-Agent': 'StreamDeckESP/1', 'X-Deck': TOKEN };
let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
type Resp = { status: number; json: any; len: number; buf: Buffer };
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length) } : {}), ...headers } }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j: any; try { j = JSON.parse(buf.toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode || 0, json: j, len: buf.length, buf }); });
  });
  r.on('error', reject); r.end(b);
});
let srv: ChildProcess;
function start(): Promise<void> {
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_DRYRUN: '1' } });
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
}
const deck = (cap = '') => req('GET', '/api/deck' + (cap ? `?cap=${cap}` : ''), undefined, BOARD).then((r) => r.json);
const merge = (slot: number, c: number, r: number) => req('POST', '/api/merge/1', { slot, c, r });
const cfg = async () => (await req('GET', '/api/config')).json;
const raw = (i: number) => req('GET', `/api/img/${i}.raw`, undefined, BOARD);

async function main() {
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 });
  await start();
  const STR = (await req('GET', '/api/settings')).json.stride as number, S = (r: number, c: number) => r * STR + c;

  section('1. juntar 2x1 (4x2, botão 73x96)');
  check((await merge(S(0, 0), 2, 1)).status === 200, 'juntar 2 colunas na linha 0');
  check((await cfg()).pages[0].buttons[S(0, 0)].span?.c === 2, 'o botão guarda span (c=2, r=1)');
  await req('PUT', `/api/button/1/${S(0, 0)}`, { label: 'Grande', action: { type: 'url', url: 'github.com' } });
  await req('PUT', `/api/button/1/${S(0, 1)}`, { label: 'Escondido', action: { type: 'text', text: 'x' } });   // conteúdo antigo de uma célula coberta (config antiga): continua guardado
  await req('PUT', `/api/button/1/${S(1, 0)}`, { label: 'Baixo', action: { type: 'media', key: 'mute' } });
  let d = await deck();
  check(d.buttons.length === 8 && !d.tiles, 'sem a capacidade "tiles" (firmware antigo): continua 8 botões 1x1, ignora a mesclagem');
  check((await raw(0)).len === 73 * 96 * 2 && (await raw(1)).status === 200, 'firmware antigo: imagem 73x96 e a célula coberta ainda existe');
  d = await deck('tiles');
  check(d.tiles === true && d.buttons.length === 7, 'com "tiles": 7 botões (a célula coberta some)', String(d.buttons.length));
  const t0 = d.buttons[0], t1 = d.buttons[1];
  check(t0.i === 0 && t0.x === 5 && t0.y === 36 && t0.w === 152 && t0.h === 96 && t0.label === 'Grande', 'tile 152x96 em (5,36) com título', JSON.stringify(t0));
  check(t1.i === 2 && t1.x === 5 + 2 * 79 && t1.w === 73, 'o botão seguinte é a célula 2 (x = 163)', JSON.stringify(t1));
  check(d.buttons.every((b: any) => b.i !== 1), 'a célula 1 (coberta) não aparece');
  check((await raw(0)).len === 152 * 96 * 2, 'imagem do tile tem o tamanho dele (152x96)');
  check((await raw(1)).status === 404, 'imagem da célula coberta: 404');
  check((await req('POST', '/api/press/1', undefined, BOARD)).status === 404, 'tocar na célula coberta: 404');
  check((await req('POST', '/api/press/0', undefined, BOARD)).status === 200, 'tocar no tile aciona o botão dele');
  const pv = await req('GET', `/api/preview/1/${S(0, 0)}.png`); check(pv.status === 200 && pv.buf.readUInt32BE(16) === 152 * 2 && pv.buf.readUInt32BE(20) === 96 * 2, 'prévia do tile em 2x (304x192)');
  check((await cfg()).pages[0].buttons[S(0, 1)].label === 'Escondido', 'o conteúdo da célula coberta continua guardado');

  section('2. validações');
  check((await merge(S(1, 0), 2, 1)).status === 400 && /vazios/.test((await merge(S(1, 0), 2, 1)).json?.erro || ''), 'juntar com um botão que tem conteúdo (S(1,0) "Baixo"): recusado, pedindo botões vazios');
  check((await merge(S(1, 1), 1, 2)).status === 400 || (await cfg()).pages[0].buttons[S(1, 1)].span === undefined, 'nada é juntado quando há conteúdo no retângulo');
  check((await merge(S(0, 1), 2, 1)).status === 400, 'cruzar outro botão juntado: recusado');
  check((await merge(S(0, STR - 1), 2, 1)).status === 400, 'passar da borda da grade virtual: recusado');
  check((await merge(S(1, 0), 1, 1)).status === 400, '1x1 não é juntar (use Separar)');
  check((await merge(S(5, 0), 2, 1)).status === 400, 'linha que não existe: recusado');
  check((await req('POST', '/api/merge/99', { slot: 0, c: 2, r: 1 })).status === 400, 'página inexistente: recusado');
  check((await req('POST', `/api/unmerge/1/${S(1, 0)}`)).status === 400, 'separar um botão que não está juntado: recusado');

  section('3. juntar 2x2 e a grade menor');
  check((await merge(S(0, 2), 2, 2)).status === 200, 'juntar 2x2 (colunas 2-3, linhas 0-1)');
  d = await deck('tiles');
  check(d.buttons.length === 4 && d.buttons.some((b: any) => b.w === 152 && b.h === 2 * 96 + 6), 'tiles: 2x1, 1x1 (linha 1 col 0), 1x1 (linha 1 col 1) e 2x2 (152x198)', JSON.stringify(d.buttons.map((b: any) => [b.i, b.w, b.h])));
  await req('PUT', '/api/settings', { cols: 3, rows: 2 }); d = await deck('tiles');
  check(d.cols === 3 && !d.buttons.some((b: any) => b.w === 152 && b.h > 100), 'grade de 3 colunas: o 2x2 (colunas 2-3) não cabe e fica escondido (guardado)', JSON.stringify(d.buttons.map((b: any) => [b.i, b.w, b.h])));
  await req('PUT', '/api/settings', { cols: 4, rows: 2 });

  section('4. separar');
  check((await req('POST', `/api/unmerge/1/${S(0, 2)}`)).status === 200 && !(await cfg()).pages[0].buttons[S(0, 2)].span, 'separar o 2x2');
  check((await req('POST', `/api/unmerge/1/${S(0, 0)}`)).status === 200, 'separar o 2x1');
  d = await deck('tiles'); check(d.buttons.length === 8 && d.buttons[1].label === 'Escondido', 'volta a 8 botões e o conteúdo escondido reaparece');

  section('5. mover e trocar botões juntados');
  const clear = (slot: number) => req('PUT', `/api/button/1/${slot}`, { label: '', action: null, color: null, clearImage: true });
  await clear(S(0, 0)); await clear(S(0, 1));   // só se junta o que está vazio
  await merge(S(0, 0), 2, 1); await req('PUT', `/api/button/1/${S(0, 0)}`, { label: 'Grande', action: { type: 'url', url: 'github.com' } });
  const mv = await req('POST', `/api/swap/1/${S(0, 0)}/${S(1, 2)}`);
  check(mv.status === 200 && (await cfg()).pages[0].buttons[S(1, 2)].span?.c === 2 && (await cfg()).pages[0].buttons[S(1, 2)].label === 'Grande' && !(await cfg()).pages[0].buttons[S(0, 0)].span, 'mover o 2x1 para um retângulo livre (linha 1, colunas 2-3)');
  check((await req('POST', `/api/swap/1/${S(1, 2)}/${S(1, 0)}`)).status === 400, 'mover o 2x1 para cima de um botão com conteúdo: recusado');
  await merge(S(0, 0), 2, 1);   // outro 2x1 (cobre a célula com "Escondido")
  const sw = await req('POST', `/api/swap/1/${S(0, 0)}/${S(1, 2)}`);
  check(sw.status === 200 && (await cfg()).pages[0].buttons[S(1, 2)].span?.c === 2 && (await cfg()).pages[0].buttons[S(0, 0)].span?.c === 2, 'dois botões juntados do mesmo tamanho trocam de lugar');
  await req('POST', `/api/swap/1/${S(0, 0)}/${S(0, 2)}`);
  check((await req('GET', '/api/config')).status === 200, 'servidor segue respondendo');

  section('5b. não cabe na grade visível (mover e juntar)');
  {
    const c0 = JSON.stringify((await cfg()).pages[0].buttons.map((b: any) => b.span ?? null));
    const bs = (await cfg()).pages[0].buttons, wide = bs.findIndex((b: any) => b.span && b.span.c >= 2);
    check(wide >= 0 && (await req('POST', `/api/swap/1/${wide}/${Math.floor(wide / STR) * STR + 3}`)).status === 400, 'mover um botão juntado largo para a coluna 4 (4 colunas visíveis: 4+2 > 4) é recusado');
    check((await merge(S(0, 3), 2, 1)).status === 400, 'juntar 2 colunas começando na coluna 4 é recusado');
    check((await merge(S(1, 0), 1, 2)).status === 400, 'juntar 2 linhas na última linha visível é recusado');
    check(JSON.stringify((await cfg()).pages[0].buttons.map((b: any) => b.span ?? null)) === c0, 'nada mudou depois das recusas');
  }

  section('6. reinício');
  srv.kill(); await new Promise((r) => setTimeout(r, 400)); await start();
  d = await deck('tiles'); check(d.buttons.some((b: any) => b.w === 152) && (await cfg()).pages[0].buttons.some((b: any) => b.span?.c === 2), 'as mesclagens sobrevivem ao reinício');

  srv.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); srv?.kill(); process.exit(1); });
