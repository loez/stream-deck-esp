// GIFs animados nos botões: upload, decodificação, decimação/limites, orçamento de preenchimento, /api/deck (cap=anim) e /api/anim/N.bin. Pastas temporárias, porta 8809, sem mDNS/plugins.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { GifWriter } from 'omggif';
import { ROOT } from '../src/env.ts';
import { decodeGif, pickFrames } from '../src/anim.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-anim-')), DATA = path.join(TMP, 'data'), PORT = 8809, TOKEN = 'anim-test-token-0123456789abcdefghij';
const BOARD = { 'User-Agent': 'StreamDeckESP/1', 'X-Deck': TOKEN };
let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
type Resp = { status: number; json: any; buf: Buffer; type: string };
const req = (method: string, p: string, body?: unknown | Buffer, headers: Record<string, string> = {}): Promise<Resp> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length) } : {}), ...headers } }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j: any; try { j = JSON.parse(buf.toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode || 0, json: j, buf, type: String(res.headers['content-type'] ?? '') }); });
  });
  r.on('error', reject); r.end(b);
});
let srv: ChildProcess;
function start(): Promise<void> {
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_DRYRUN: '1' } });
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
}
/** GIF de fixture: quadros de cor lisa (paleta preto/vermelho/verde/azul) com atrasos em centésimos de segundo. */
function makeGif(w: number, h: number, frames: { color: number; cs: number }[]): Buffer {
  const buf = Buffer.alloc(w * h * frames.length * 2 + 2048), gw = new GifWriter(buf, w, h, { palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff] });
  for (const f of frames) gw.addFrame(0, 0, w, h, new Uint8Array(w * h).fill(f.color), { delay: f.cs });
  return buf.subarray(0, gw.end());
}
const getDeck = (q: string) => req('GET', '/api/deck?' + q, undefined, BOARD).then((r) => r.json);
const upload = (slot: number, gif: Buffer) => req('POST', `/api/button/1/${slot}/image`, gif);

async function main() {
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 });
  await start();
  const STR = (await req('GET', '/api/settings')).json.stride as number;

  section('1. decodificação e limites (módulo)');
  const g3 = decodeGif(makeGif(20, 20, [{ color: 1, cs: 10 }, { color: 2, cs: 10 }, { color: 3, cs: 30 }]));
  check(g3.w === 20 && g3.h === 20 && g3.frames.length === 3 && g3.frames.map((f) => f.delay).join() === '100,100,300', 'GIF de 3 quadros: tamanho, quadros e atrasos (ms)');
  check(g3.frames[0]!.rgba[0] === 255 && g3.frames[0]!.rgba[1] === 0 && g3.frames[1]!.rgba[1] === 255 && g3.frames[2]!.rgba[2] === 255, 'cada quadro tem a sua cor (vermelho, verde, azul)');
  const p = pickFrames(Array(60).fill(20), { minDelay: 70, maxFrames: 32, maxBytes: 1e9 });
  check(p.idx.length === 15 && p.delay.every((d) => d >= 70) && p.delay.reduce((a, b) => a + b, 0) === 1200, '60 quadros de 20 ms: atraso mínimo de 70 ms agrupa em 15 quadros e preserva a duração total', `${p.idx.length} ${p.delay.slice(0, 3)}`);
  const p2 = pickFrames(Array(100).fill(100), { minDelay: 70, maxFrames: 32, maxBytes: 1e9 });
  check(p2.idx.length <= 32 && p2.delay.reduce((a, b) => a + b, 0) === 10000, '100 quadros: no máximo 32 e a duração total é preservada', String(p2.idx.length));
  const many = decodeGif(makeGif(8, 8, Array.from({ length: 301 }, () => ({ color: 1, cs: 5 }))));
  check(many.frames.length <= 120 && many.frames.reduce((a, f) => a + f.delay, 0) === 301 * 50, 'GIF com 301 quadros: reduzido a no máx. 120 e a duração total é mantida', `${many.frames.length}`);
  check(decodeGif(makeGif(1400, 900, [{ color: 1, cs: 5 }, { color: 2, cs: 5 }])).w <= 640, 'GIF 1400x900: imagem reduzida para no máx. 640 px');

  section('2. upload e /api/deck');
  const up = await upload(0, makeGif(20, 20, [{ color: 1, cs: 10 }, { color: 2, cs: 10 }, { color: 3, cs: 30 }]));
  const cfg = (await req('GET', '/api/config')).json, name = cfg.pages[0].buttons[0].image as string;
  check(up.status === 200 && up.json.gif === true && /\.gif$/.test(name), 'upload de GIF: guardado como .gif');
  const got = await req('GET', '/api/upload/' + encodeURIComponent(name));
  check(got.status === 200 && got.type === 'image/gif' && got.buf.toString('latin1', 0, 3) === 'GIF', 'o GIF original é servido à página (animado)');
  check((await req('GET', '/api/upload/..%2Fconfig.json')).status === 404, 'nome fora do padrão: 404');
  check((await req('GET', '/api/preview/1/0.png')).status === 200, 'a prévia estática (1º quadro) gera');
  let d = await getDeck('cap=tiles');
  check(d.buttons[0].anim === undefined, 'sem a capacidade "anim": sem campo de animação');
  d = await getDeck('cap=tiles,anim&fill=1000000');
  check(d.buttons[0].anim?.n === 3 && Number.isInteger(d.buttons[0].anim.rev) && d.buttons[1].anim === undefined, 'com "anim": o botão do GIF traz {n:3, rev}; os outros não', JSON.stringify(d.buttons[0].anim));
  const rev1 = d.buttons[0].anim.rev;
  check((await getDeck('cap=tiles,anim&fill=1000000')).buttons[0].anim.rev === rev1, 'a versão da animação é estável entre consultas');
  check((await getDeck('cap=tiles,anim&fill=20000')).buttons[0].anim === undefined, 'preenchimento muito baixo (fill=20000): atraso mínimo sobe e os 3 quadros viram 1 → sem animação');
  const rev2 = (await getDeck('cap=tiles,anim&fill=100000')).buttons[0].anim?.rev;
  check(rev2 !== undefined && rev2 !== rev1, 'fill diferente muda a versão (a placa baixa de novo)', `${rev1} ${rev2}`);

  section('3. /api/anim/N.bin');
  await getDeck('cap=tiles,anim&fill=1000000');
  const bin = await req('GET', '/api/anim/0.bin', undefined, BOARD), b = bin.buf, per = 73 * 96 * 2;
  check(bin.status === 200 && b.readUInt16LE(0) === 3 && b.readUInt16LE(2) === 0, 'cabeçalho: 3 quadros');
  check([4, 6, 8].map((o) => b.readUInt16LE(o)).join() === '100,100,300', 'atrasos 100, 100, 300 ms');
  check(b.length === 4 + 6 + 3 * per, 'tamanho = cabeçalho + 3 quadros de 73x96 RGB565', String(b.length));
  const px = (f: number) => { const o = 10 + f * per + (48 * 73 + 36) * 2; return b.readUInt16LE(o); };   // pixel central do quadro f
  check((px(0) >> 11) > 28 && ((px(0) >> 5) & 63) < 4 && (px(1) >> 5 & 63) > 58 && (px(2) & 31) > 28 && (px(2) >> 11) < 3, 'cores dos quadros: vermelho, verde, azul', [px(0), px(1), px(2)].map((v) => v.toString(16)).join());
  check((await req('GET', '/api/anim/5.bin', undefined, BOARD)).status === 404, 'botão sem GIF: 404');
  check((await req('GET', '/api/anim/0.bin')).status === 401, 'sem token: 401');

  section('4. botão juntado e troca de imagem');
  await req('PUT', '/api/button/1/0', { label: '', action: null, clearImage: true });   // só se junta o que está vazio: limpa, junta e envia o GIF de novo ao tile
  await req('POST', '/api/merge/1', { slot: 0, c: 2, r: 1 });
  await upload(0, makeGif(20, 20, [{ color: 1, cs: 10 }, { color: 2, cs: 10 }, { color: 3, cs: 30 }]));
  d = await getDeck('cap=tiles,anim&fill=1000000');
  check(d.buttons[0].w === 152 && d.buttons[0].anim?.n === 3 && d.buttons[0].anim.rev !== rev1, 'GIF no botão 2x1: a animação é refeita no tamanho do botão (152x96)');
  check((await req('GET', '/api/anim/0.bin', undefined, BOARD)).buf.length === 4 + 6 + 3 * 152 * 96 * 2, 'quadros de 152x96');
  check((await req('GET', '/api/anim/1.bin', undefined, BOARD)).status === 404, 'célula coberta: 404');
  await req('POST', `/api/unmerge/1/0`);

  section('5. validações e remoção');
  check((await upload(1, Buffer.from('GIF89a' + 'x'.repeat(40)))).status === 400, 'GIF corrompido: 400');
  { const big = await upload(1, makeGif(8, 8, Array.from({ length: 301 }, () => ({ color: 1, cs: 5 })))); check(big.status === 200, 'GIF com 301 quadros: aceito e adaptado (sem erro)'); }
  { const wide = await upload(1, makeGif(1400, 900, [{ color: 1, cs: 5 }, { color: 2, cs: 5 }])); check(wide.status === 200, 'GIF 1400x900 (acima de 1024): aceito e adaptado (sem erro)'); await req('PUT', '/api/button/1/1', { label: '', action: null, clearImage: true }); }
  const before = fs.readdirSync(path.join(DATA, 'uploads')).filter((f) => f.endsWith('.gif')).length;
  await upload(0, makeGif(10, 10, [{ color: 2, cs: 10 }, { color: 1, cs: 10 }]));
  check(fs.readdirSync(path.join(DATA, 'uploads')).filter((f) => f.endsWith('.gif')).length === before, 'trocar o GIF apaga o anterior');
  await req('PUT', '/api/button/1/0', { label: '', action: null, clearImage: true });
  check(fs.readdirSync(path.join(DATA, 'uploads')).filter((f) => f.endsWith('.gif')).length === 0 && (await getDeck('cap=tiles,anim&fill=1000000')).buttons[0].anim === undefined, 'remover a imagem apaga o GIF e a animação some');
  void STR;

  srv.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  section('GIF inteiro no botão (sem cortar)');
  { const { fitInside } = await import('../src/resample.ts'); const W = 40, H = 40, src = { w: 20, h: 10, data: new Uint8ClampedArray(20 * 10 * 4).fill(255) };
    const o = fitInside(src, W, H), px = (x: number, y: number) => o.data[(y * W + x) * 4]!;
    check(px(20, 20) === 255 && px(20, 2) === 22 && px(20, 37) === 22 && px(1, 20) === 255, 'imagem 2:1 em botão quadrado: largura inteira, faixas escuras em cima e embaixo'); }
  console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); srv?.kill(); process.exit(1); });
