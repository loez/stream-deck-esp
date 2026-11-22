// Migração da grade virtual (4 -> 8 colunas) e tela informada pela placa (tamanho/densidade -> grade e limites). Pastas temporárias, porta 8807, sem mDNS, sem plugins.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-stride-')), DATA = path.join(TMP, 'data'), PORT = 8807, TOKEN = 'stride-test-token-0123456789abcdefgh';
const BOARD = { 'User-Agent': 'StreamDeckESP/1', 'X-Deck': TOKEN };
let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
type Resp = { status: number; json: any; len: number };
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length) } : {}), ...headers } }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j: any; try { j = JSON.parse(buf.toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode || 0, json: j, len: buf.length }); });
  });
  r.on('error', reject); r.end(b);
});
let srv: ChildProcess;
function start(): Promise<void> {
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_DRYRUN: '1' } });
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
}
const deck = (q = '') => req('GET', '/api/deck' + q, undefined, BOARD).then((r) => r.json);

async function main() {
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 });
  // configuração no formato antigo (4 colunas virtuais, 8 slots): botão i = "L<i>"
  const btn = (i: number) => ({ label: `L${i}`, action: null, color: null, image: null, imgrev: 1 });
  const old = { rev: 1, next_id: 3, current: 1, pages: [{ id: 1, name: 'Principal', buttons: Array.from({ length: 8 }, (_, i) => btn(i)) }, { id: 2, name: 'Outra', buttons: Array.from({ length: 8 }, (_, i) => btn(10 + i)) }] };
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(old, null, 2));
  await start();
  const st0 = (await req('GET', '/api/settings')).json, STR = st0.stride as number;

  section('1. migração da grade virtual de 4 para ' + STR + ' colunas');
  let cfg = (await req('GET', '/api/config')).json;
  check(cfg.stride === STR, 'config guarda o formato (stride)', String(cfg.stride));
  check(cfg.pages[0].buttons.length === STR * 2 && cfg.pages[0].buttons[1 * STR + 1].label === 'L5' && cfg.pages[0].buttons[0].label === 'L0' && cfg.pages[0].buttons[3].label === 'L3' && cfg.pages[0].buttons[STR + 3].label === 'L7', 'cada botão mantém linha e coluna (L5 = linha 1, coluna 1)');
  check(cfg.pages[1].buttons[1 * STR + 2].label === 'L16', 'a 2ª página também migrou');
  check(fs.existsSync(path.join(DATA, 'config.json.bak-stride4')) && JSON.parse(fs.readFileSync(path.join(DATA, 'config.json.bak-stride4'), 'utf8')).pages[0].buttons.length === 8, 'a configuração original foi guardada em config.json.bak-stride4');
  let d = await deck(); check(d.buttons[5].label === 'L5' && d.buttons[7].label === 'L7', 'a placa vê os botões nas mesmas posições (índice 5 = L5)');
  srv.kill(); await new Promise((r) => setTimeout(r, 400)); await start();
  cfg = (await req('GET', '/api/config')).json; d = await deck();
  check(cfg.pages[0].buttons[1 * STR + 1].label === 'L5' && d.buttons[5].label === 'L5', 'depois de reiniciar não migra de novo (nada muda de lugar)');

  section('2. tela informada pela placa');
  d = await deck();
  check(d.cols === 4 && d.w === 73 && d.h === 96, 'sem informar a tela: assume 320x240 (grade 4x2, botão 73x96)');
  check((await req('GET', '/api/settings')).json.limits.cols[1] === 4 && (await req('GET', '/api/settings')).json.limits.rows[1] === 4, 'limites da tela 2,8": até 4x4 (o dedo precisa de ~12x7,5 mm)');
  d = await deck('?w=800&h=480&ppi=217');   // tela de 4,3" 800x480
  let s = (await req('GET', '/api/settings')).json;
  check(s.screen.w === 800 && s.screen.h === 480 && s.screen.ppi === 217 && s.limits.cols[1] === 7 && s.limits.rows[1] === 6, 'tela 800x480 (217 ppi): cabem até 7 colunas x 6 linhas (botão de pelo menos 12x7,5 mm)', JSON.stringify({ screen: s.screen, limits: s.limits }));
  check((await req('PUT', '/api/settings', { cols: 7, rows: 5, font: 14 })).status === 200, 'aceita 7x5 nessa tela');
  d = await deck();
  check(d.cols === 7 && d.rows === 5 && d.buttons.length === 35 && d.w === 107 && d.h === 83, 'botão 107x83 com 35 botões', JSON.stringify({ w: d.w, h: d.h, n: d.buttons.length }));
  check((await req('GET', '/api/img/34.raw', undefined, BOARD)).len === 107 * 83 * 2 && (await req('GET', '/api/img/35.raw', undefined, BOARD)).status === 404, 'imagem do último botão (34) tem o tamanho certo; 35 não existe');
  check(d.buttons[0].label === 'L0' && d.buttons[8].label === 'L5' && d.buttons[10].label === 'L7' && d.buttons[4].label === '', 'os botões migrados continuam nas mesmas linhas/colunas (grade de 7 colunas: L5 = linha 1 coluna 1 = índice 8)');
  const cfg2 = (await req('GET', '/api/config')).json; check(cfg2.pages[0].buttons.length >= STR * 5, 'páginas ganham slots para as 5 linhas');
  check((await req('PUT', '/api/settings', { cols: 8 })).status === 400 && (await req('PUT', '/api/settings', { rows: 7 })).status === 400, '8 colunas / 7 linhas: recusado (passa do que cabe)');
  const bad = await deck('?w=10&h=10&ppi=5'); check((await req('GET', '/api/settings')).json.screen.w === 800, 'tela inválida informada pela placa é ignorada');
  void bad;
  srv.kill(); await new Promise((r) => setTimeout(r, 400)); await start();
  s = (await req('GET', '/api/settings')).json; check(s.screen.w === 800 && s.cols === 7, 'a tela e a grade escolhida sobrevivem ao reinício (settings.json)');
  d = await deck('?w=320&h=240&ppi=143');   // voltou para a placa pequena
  s = (await req('GET', '/api/settings')).json;
  check(d.cols === 4 && d.rows === 4 && d.w === 73 && d.h === 45 && s.cols === 7, 'tela menor: a grade é ajustada ao que cabe (4x4) sem perder a escolha anterior (7x5 salvo)', JSON.stringify({ cols: d.cols, rows: d.rows, escolha: s.cols }));

  srv.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); srv?.kill(); process.exit(1); });
