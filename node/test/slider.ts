// Teste dos controles deslizantes: lógica (slider.ts, com sistema de mentira) e servidor (validação da ação, campo "sl" do /api/deck, POST /api/slide, prévia). Porta 8844, DECK_DRYRUN.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';
import { slide, refreshLevel, levelOf, sliderAxis, sliderColor, isAbsolute, forget } from '../src/slider.ts';
import type { Sys } from '../src/slider.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fakeSys(delay = 0, appResult: [boolean, string] = [true, 'ok']) {
  const calls: string[] = [];
  const sys: Sys = {
    volumeGet: async () => 37, volumeSet: async (p) => { calls.push(`vol ${p}`); if (delay) await sleep(delay); return true; },
    appVolumeGet: async () => 62, appVolumeSet: async (a, p) => { calls.push(`app ${a} ${p}`); if (delay) await sleep(delay); return appResult; },
    media: async (k) => { calls.push(`media ${k}`); return [true, 'ok']; }, hotkey: async (m, k) => { calls.push(`key ${m.join('+')}|${k.join(':')}`); return [true, 'ok']; },
  };
  return { sys, calls };
}

const PORT = 8844, TOKEN = 'tok-slider-teste-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-slider-')), DATA = path.join(TMP, 'data');
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; raw: Buffer }> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length), 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => { const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const raw = Buffer.concat(ch); let j: any; try { j = JSON.parse(raw.toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode ?? 0, json: j, raw }); }); });
  r.on('error', reject); r.end(b);
});
const BOARD = { 'X-Deck': TOKEN, 'User-Agent': 'StreamDeckESP/1' };
let srv: ChildProcess, out = '';

async function main() {
  section('formato e cores');
  check(sliderAxis({}, 3, 1) === 'h' && sliderAxis({}, 1, 3) === 'v' && sliderAxis({}, 2, 2) === 'h', 'orientação automática pelo formato (3x1 horizontal, 1x3 vertical)');
  check(sliderAxis({ axis: 'v' }, 3, 1) === 'v' && sliderAxis({ axis: 'h' }, 1, 3) === 'h', 'orientação forçada vale mais que o formato');
  check(isAbsolute({ mode: 'volume' }) && isAbsolute({ mode: 'appvolume' }) && !isAbsolute({ mode: 'brightness' }) && !isAbsolute({ mode: 'scrub' }), 'volume é absoluto; brilho e linha do tempo são relativos');
  check(sliderColor({ mode: 'appvolume', app: 'spotify' }) === 0x1db954 && sliderColor({ mode: 'appvolume', app: 'music' }) !== 0x1db954, 'cor do Spotify (verde) e do Apple Music diferentes');

  section('volume do sistema (absoluto)');
  forget(); let f = fakeSys();
  slide('1:3', { mode: 'volume' }, 500, 0, f.sys); await sleep(20);
  check(f.calls.join() === 'vol 50' && levelOf('1:3') === 500, 'posição 500/1000 ajusta o volume em 50% e guarda o nível', f.calls.join());
  slide('1:3', { mode: 'volume' }, 1500, 1, f.sys); await sleep(20);
  check(f.calls[f.calls.length - 1] === 'vol 100', 'posição acima do fim é limitada a 100%');
  slide('1:3', { mode: 'volume' }, -40, 1, f.sys); await sleep(20);
  check(f.calls[f.calls.length - 1] === 'vol 0', 'posição negativa é limitada a 0%');
  forget(); f = fakeSys(60);
  for (const v of [100, 300, 500, 700, 900]) slide('1:4', { mode: 'volume' }, v, 1, f.sys);
  await sleep(200);
  check(f.calls.join() === 'vol 10,vol 90', 'arrastar rápido não empilha chamadas: a 1ª e depois só o valor mais recente', f.calls.join());
  forget(); f = fakeSys(); await refreshLevel('1:5', { mode: 'volume' }, f.sys);
  check(levelOf('1:5') === 370, 'releitura do sistema atualiza o nível (37% = 370)');
  slide('1:5', { mode: 'volume' }, 800, 2, f.sys); await refreshLevel('1:5', { mode: 'volume' }, f.sys);
  check(levelOf('1:5') === 800, 'logo depois de um arrasto a releitura não briga com o dedo');

  section('volume do Spotify / Music (absoluto)');
  forget(); f = fakeSys();
  slide('1:6', { mode: 'appvolume', app: 'spotify' }, 250, 0, f.sys); await sleep(20);
  check(f.calls.join() === 'app spotify 25', 'ajusta o volume do Spotify', f.calls.join());
  f = fakeSys(0, [false, 'app fechado']); slide('1:7', { mode: 'appvolume', app: 'music' }, 600, 1, f.sys); await sleep(20);
  check(slide('1:7', { mode: 'appvolume', app: 'music' }, 610, 1, f.sys).err === 'app fechado', 'app fechado: o erro volta para a placa/servidor');

  section('brilho e linha do tempo (relativos)');
  forget(); f = fakeSys();
  slide('1:8', { mode: 'brightness', sens: 24 }, 500, 0, f.sys);
  slide('1:8', { mode: 'brightness', sens: 24 }, 600, 1, f.sys); await sleep(30);
  check(f.calls.join() === 'media brightup,media brightup', 'arrastar 10% do botão com 24 passos/botão = 2 passos de brilho (acumula a fração 0,4)', f.calls.join());
  slide('1:8', { mode: 'brightness', sens: 24 }, 500, 1, f.sys); await sleep(30);
  check(f.calls.slice(2).join() === 'media brightdown,media brightdown', 'arrastar de volta diminui');
  slide('1:8', { mode: 'brightness', sens: 24 }, 520, 1, f.sys); slide('1:8', { mode: 'brightness', sens: 24 }, 540, 1, f.sys); await sleep(30);
  check(f.calls.length === 4, 'movimentos pequenos acumulam sem disparar (0,48 + 0,48 = 0,96 de passo)', String(f.calls.length));
  slide('1:8', { mode: 'brightness', sens: 24 }, 560, 1, f.sys); await sleep(30);
  check(f.calls.length === 5 && f.calls[4] === 'media brightup', 'ao somar um passo inteiro (1,44), dispara um passo', String(f.calls.length));
  forget(); f = fakeSys();
  slide('1:9', { mode: 'scrub', sens: 10, inc: 'shift+right', dec: 'shift+left' }, 100, 0, f.sys);
  slide('1:9', { mode: 'scrub', sens: 10, inc: 'shift+right', dec: 'shift+left' }, 300, 1, f.sys); await sleep(30);
  check(f.calls.join() === 'key shift|code:124,key shift|code:124', 'linha do tempo: 20% do botão com 10 passos = 2 vezes Shift+→', f.calls.join());
  forget(); f = fakeSys();
  slide('1:10', { mode: 'scrub' }, 0, 0, f.sys); slide('1:10', { mode: 'scrub' }, 1000, 1, f.sys); await sleep(50);
  check(f.calls.length === 24 && f.calls[0] === 'key |code:124', 'arrasto do botão inteiro (sens padrão 24) = 24 passos, tecla → por padrão', String(f.calls.length));
  forget(); f = fakeSys();
  slide('1:11', { mode: 'brightness', sens: 80 }, 0, 0, f.sys); slide('1:11', { mode: 'brightness', sens: 80 }, 1000, 1, f.sys); await sleep(100);
  check(f.calls.length <= 31, 'um salto enorme não dispara centenas de teclas (limite de 30 por vez)', String(f.calls.length));

  section('servidor');
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 });
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_NORES: '1', DECK_DRYRUN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout!.on('data', (d) => (out += d)); srv.stderr!.on('data', (d) => (out += d));
  for (let i = 0; i < 60; i++) { try { if ((await req('GET', '/api/config')).status === 200) break; } catch { /* sobe */ } await sleep(250); }
  const STR = (await req('GET', '/api/settings')).json.stride as number, S = (r: number, c: number) => r * STR + c;
  const put = (slot: number, action: unknown) => req('PUT', `/api/button/1/${slot}`, { label: '', action });
  check((await put(S(1, 0), { type: 'slider', mode: 'nada' })).status === 400, 'modo inválido é recusado');
  check((await put(S(1, 0), { type: 'multi', mode: 'seq', steps: [{ type: 'slider', mode: 'volume' }] })).status === 400, 'não pode ser passo de uma sequência');
  check((await put(S(1, 0), { type: 'slider', mode: 'scrub', inc: 'ctrl+invalida+x' })).status === 400, 'tecla inválida no modo linha do tempo é recusada');
  check((await req('POST', '/api/merge/1', { slot: S(1, 0), c: 3, r: 1 })).status === 200, 'juntar 3x1');
  check((await put(S(1, 0), { type: 'slider', mode: 'volume' })).status === 200, 'salvar controle de volume no botão 3x1');
  check((await req('POST', '/api/merge/1', { slot: S(0, 3), c: 1, r: 2 })).status === 200 && (await put(S(0, 3), { type: 'slider', mode: 'brightness', sens: 500 })).status === 200, 'salvar brilho num 1x2');
  const cfg = (await req('GET', '/api/config')).json.pages[0].buttons;
  check(cfg[S(0, 3)].action.sens === 80 && cfg[S(1, 0)].action.app === undefined, 'sensibilidade é limitada (4-80) e o volume do sistema não guarda app', JSON.stringify(cfg[S(0, 3)].action));
  const deckNo = (await req('GET', '/api/deck?cap=tiles', undefined, BOARD)).json;
  check(deckNo.buttons.every((b: any) => !('sl' in b)), 'firmware sem a capacidade "slide": não recebe o campo sl');
  const deck = (await req('GET', '/api/deck?cap=tiles,slide', undefined, BOARD)).json;
  const sl1 = deck.buttons.find((b: any) => b.i === 4), sl2 = deck.buttons.find((b: any) => b.i === 3);
  check(sl1?.sl?.o === 'h' && sl1.sl.r === 0 && sl1.sl.c === 0x19d9c8 && sl1.w > 200, 'tile 3x1: sl = horizontal, absoluto, cor do volume', JSON.stringify(sl1?.sl));
  check(sl2?.sl?.o === 'v' && sl2.sl.r === 1 && sl2.h > 100, 'tile 1x2: sl = vertical, relativo (brilho)', JSON.stringify(sl2?.sl));
  const idxVol = sl1.i;
  check((await req('POST', `/api/slide/${idxVol}?v=500&p=0`)).status === 401, 'sem o token da placa: 401');
  let r = await req('POST', `/api/slide/${idxVol}?v=500&p=0`, undefined, BOARD);
  check(r.status === 200 && r.json.v === 500 && r.json.ok === true, 'arrasto aceito: devolve o nível', JSON.stringify(r.json));
  await sleep(300);
  check(/\[dryrun\].*osascript.*volume output volume 50|\[dryrun\].*pactl|\[dryrun\].*powershell/.test(out), 'o servidor pediu ao sistema volume 50% (modo de teste só imprime o comando)', out.split('\n').filter((l) => l.includes('dryrun')).pop() ?? '');
  check((await req('POST', `/api/slide/${idxVol}?v=abc&p=1`, undefined, BOARD)).status === 404 && (await req('POST', `/api/slide/${idxVol}?v=1&p=9`, undefined, BOARD)).status === 404, 'valores inválidos: recusados');
  check((await req('POST', `/api/slide/0?v=500&p=1`, undefined, BOARD)).status === 404 || (await req('POST', `/api/slide/6?v=500&p=1`, undefined, BOARD)).status === 404, 'botão que não é controle deslizante: 404');
  const st = (await req('GET', '/api/status')).json;
  check(Object.keys(st.pv).some((k) => st.pv[k] > 0), 'a versão da prévia do slider sobe quando o nível muda (a página recarrega a prévia)', JSON.stringify(st.pv));
  const png = await req('GET', `/api/preview/1/${S(1, 0)}.png`);
  check(png.status === 200 && png.raw.subarray(1, 4).toString() === 'PNG' && png.raw.length > 400, 'a prévia do controle é desenhada (PNG)');
  const raw = await req('GET', `/api/img/${idxVol}.raw`, undefined, BOARD);
  check(raw.status === 200 && raw.raw.length === sl1.w * sl1.h * 2, 'a imagem da placa tem o tamanho do tile (o preenchimento é desenhado pelo firmware)');
  r = await req('POST', `/api/press/${idxVol}`, undefined, BOARD);
  check(r.status === 200 && /arraste/.test(r.json.msg), 'tocar (sem arrastar) só explica como usar');
}
main().catch((e) => { console.error('ERRO NO TESTE:', e); fails.push('erro: ' + e); }).finally(() => {
  srv?.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + '='.repeat(60) + `\n${checks} verificações, ${fails.length} falha(s)`);
  if (fails.length) { for (const x of fails) console.log('  FALHA: ' + x); process.exit(1); }
});
