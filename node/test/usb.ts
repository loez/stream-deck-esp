// Teste da conexão por cabo (usb.ts): quadros, ruído de log no meio, e uma "placa falsa" falando com o servidor real pela ponte. Porta 8841, sem mDNS/USB real.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';
import { encodeFrame, FrameParser, UsbSession, localRequest, T } from '../src/usb.ts';
import type { Frame, Link } from '../src/usb.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Pipe extends EventEmitter implements Link {   // uma ponta de um cabo de mentira
  peer!: Pipe; closed = false;
  write(d: Buffer, cb?: (e?: Error | null) => void): boolean { const c = Buffer.from(d); setImmediate(() => { if (!this.peer.closed) this.peer.emit('data', c); }); cb?.(); return true; }
  close(): void { this.closed = true; this.emit('close'); this.peer.emit('close'); }
}
const cable = (): [Pipe, Pipe] => { const a = new Pipe(), b = new Pipe(); a.peer = b; b.peer = a; return [a, b]; };

async function main() {
  section('quadros');
  const f = encodeFrame(T.REQ, 513, Buffer.from('xyz'));
  check(f.length === 13 && f[0] === 0xa5 && f[1] === 0x5a && f[2] === T.REQ && f.readUInt16LE(3) === 513 && f.readUInt32LE(5) === 3, 'cabeçalho: magia, tipo, id, tamanho');
  const got: Frame[] = [], text: string[] = [];
  const parser = new FrameParser((x) => got.push(x), (t) => text.push(t.toString('latin1')));
  const stream = Buffer.concat([Buffer.from('[rede] log antigo\n'), encodeFrame(T.BEACON, 0, Buffer.from('deck')), Buffer.from('ruido \xa5 solto \xa5\x5a falso\n', 'latin1'), encodeFrame(T.RES, 7, Buffer.alloc(5000, 9)), Buffer.from('fim\n')]);
  for (let i = 0; i < stream.length; i += 37) parser.feed(stream.subarray(i, i + 37));   // chegando em pedaços de 37 bytes
  check(got.length === 2 && got[0]!.type === T.BEACON && got[1]!.type === T.RES && got[1]!.payload.length === 5000 && got[1]!.payload.every((b) => b === 9), 'dois quadros reconhecidos entre logs, em pedaços', JSON.stringify(got.map((g) => [g.type, g.payload.length])));
  check(text.join('').includes('log antigo') && text.join('').includes('fim') && text.join('').includes('falso'), 'texto de log e falsos começos de quadro passam como texto');

  section('sessão com placa falsa (servidor de mentira)');
  const [host, board] = cable();
  const calls: string[] = [];
  const s = new UsbSession(host, async (m, p) => { calls.push(`${m} ${p}`); return { status: p.includes('img') ? 200 : 404, body: Buffer.alloc(p.includes('img') ? 12264 : 2, 7) }; });
  const bframes: Frame[] = []; const bp = new FrameParser((x) => bframes.push(x)); board.on('data', (b: Buffer) => bp.feed(b));
  const pr = s.probe(1500); await sleep(30);
  check(bframes.some((x) => x.type === T.PROBE), 'o servidor pergunta quem é (PROBE)');
  board.write(encodeFrame(T.BEACON, 0, Buffer.from('streamdeck-esp')));
  check((await pr) === 'streamdeck-esp', 'a placa responde com seu nome (BEACON)');
  s.start(); await sleep(50);
  check(bframes.some((x) => x.type === T.HELLO), 'o servidor avisa que está presente (HELLO)');
  board.write(encodeFrame(T.REQ, 1, Buffer.concat([Buffer.from([1]), Buffer.from('/api/img/3.raw')])));
  board.write(encodeFrame(T.REQ, 2, Buffer.concat([Buffer.from([2]), Buffer.from('/api/press/3')])));
  board.write(encodeFrame(T.REQ, 3, Buffer.concat([Buffer.from([1]), Buffer.from('/etc/passwd')])));
  await sleep(300);
  const r1 = bframes.find((x) => x.type === T.RES && x.id === 1), r2 = bframes.find((x) => x.type === T.RES && x.id === 2), r3 = bframes.find((x) => x.type === T.RES && x.id === 3);
  check(!!r1 && r1.payload.readUInt16LE(0) === 200 && r1.payload.length === 2 + 12264, 'imagem de 12 KB volta inteira com status 200');
  check(!!r2 && r2.payload.readUInt16LE(0) === 404, 'o status do servidor chega à placa (404)');
  check(!!r3 && r3.payload.readUInt16LE(0) === 400 && calls.length === 2, 'caminho fora de /api/ é recusado sem chegar ao servidor', JSON.stringify(calls));
  check(calls[0] === 'GET /api/img/3.raw' && calls[1] === 'POST /api/press/3', 'método e caminho corretos');
  let closed = false; s.onClose = () => { closed = true; }; board.close(); await sleep(20);
  check(closed && s.closed, 'cabo desconectado encerra a sessão');

  section('placa falsa contra o servidor real');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-usb-')), DATA = path.join(TMP, 'data'), PORT = 8841;
  fs.mkdirSync(DATA, { recursive: true });
  const srv: ChildProcess = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_NORES: '1', DECK_DRYRUN: '1' }, stdio: 'ignore' });
  try {
    const tokFile = fs.readdirSync(DATA).find((n) => /token/i.test(n));
    for (let i = 0; i < 50 && !fs.existsSync(path.join(DATA, tokFile ?? 'token')); i++) await sleep(200);
    const tf = fs.readdirSync(DATA).find((n) => /token/i.test(n))!, token = fs.readFileSync(path.join(DATA, tf), 'utf8').trim();
    const [h2, b2] = cable(); const frames: Frame[] = []; const p2 = new FrameParser((x) => frames.push(x)); b2.on('data', (b: Buffer) => p2.feed(b));
    const s2 = new UsbSession(h2, localRequest(PORT, token)); s2.start();
    const ask = (id: number, m: number, p: string) => b2.write(encodeFrame(T.REQ, id, Buffer.concat([Buffer.from([m]), Buffer.from(p)])));
    for (let i = 0; i < 20; i++) { ask(1, 1, '/api/deck?w=320&h=240&ppi=166&fill=0&cap=tiles,anim&bmv=4100'); await sleep(250); if (frames.some((x) => x.type === T.RES && x.id === 1)) break; }
    const deck = frames.find((x) => x.type === T.RES && x.id === 1);
    const body = deck ? JSON.parse(deck.payload.subarray(2).toString('utf8')) : null;
    check(!!deck && deck.payload.readUInt16LE(0) === 200 && Array.isArray(body?.buttons) && body.tiles === true, '/api/deck pelo cabo devolve a lista de botões (tiles)', JSON.stringify(deck?.payload.subarray(0, 80).toString()));
    ask(2, 1, `/api/img/${body.buttons[0].i}.raw`); await sleep(1500);
    const img = frames.find((x) => x.type === T.RES && x.id === 2);
    check(!!img && img.payload.readUInt16LE(0) === 200 && img.payload.length - 2 === body.buttons[0].w * body.buttons[0].h * 2, 'imagem RGB565 do botão pelo cabo tem o tamanho certo', `${img?.payload.length}`);
    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json() as any;
    check(st.board_ip === 'USB' && st.connected === true, 'o servidor mostra a placa como conectada por USB', JSON.stringify([st.board_ip, st.connected]));
    const bad = await (await fetch(`http://127.0.0.1:${PORT}/api/deck`, { headers: { 'X-Deck': 'errado' } })).status;
    check(bad === 401, 'sem o token do servidor continua 401');
    s2.end();
  } finally { srv.kill(); fs.rmSync(TMP, { recursive: true, force: true }); }

  console.log('\n' + '='.repeat(60) + `\n${checks} verificações, ${fails.length} falha(s)`);
  if (fails.length) { for (const x of fails) console.log('  FALHA: ' + x); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
