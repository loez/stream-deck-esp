// Teste de "segurar = ação alternativa" (campo alt, /api/press?long=1) e de "deslizar = trocar de página" (/api/swipe/next|prev). Porta 8853; webhooks falsos na 8954.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const PORT = 8853, HOOK = 8954, TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-hold-')), DATA = path.join(TMP, 'data');
const hits: string[] = []; const hook = http.createServer((q, r) => { hits.push(String(q.url)); r.writeHead(200); r.end('ok'); });
let token = '';
const req = (method: string, p: string, body?: unknown, auth = false): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length), 'Content-Type': 'application/json' } : {}), ...(auth ? { 'X-Deck': token } : {}) } }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { let j: any; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode || 0, json: j }); });
  });
  r.on('error', reject); r.end(b);
});
let srv: ChildProcess;
const wh = (name: string) => ({ type: 'webhook', url: `http://127.0.0.1:${HOOK}/${name}`, method: 'GET' });

async function main() {
  await new Promise<void>((r) => hook.listen(HOOK, '127.0.0.1', r));
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_NORES: '1' } });
  await new Promise<void>((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
  token = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();

  console.log('== segurar');
  check((await req('PUT', '/api/button/1/0', { label: 'A', action: wh('toque'), alt: wh('segurar') })).json?.ok === true, 'botão com ação e ação ao segurar salvo');
  check((await req('PUT', '/api/button/1/1', { label: 'B', action: wh('so-toque') })).json?.ok === true, 'botão sem ação ao segurar salvo');
  check((await req('GET', '/api/config')).json.pages[0].buttons[0].alt?.url.endsWith('/segurar'), 'alt aparece na configuração');
  await req('POST', '/api/press/0', undefined, true); check(hits.at(-1) === '/toque', 'toque executa a ação normal', String(hits));
  await req('POST', '/api/press/0?long=1', undefined, true); check(hits.at(-1) === '/segurar', 'segurar executa a ação alternativa', String(hits));
  await req('POST', '/api/press/1?long=1', undefined, true); check(hits.at(-1) === '/so-toque', 'segurar sem ação alternativa = toque normal', String(hits));
  check((await req('POST', '/api/press/0?long=1')).status === 401, 'segurar sem o token da placa: 401');
  check((await req('PUT', '/api/button/1/2', { label: 'C', action: wh('x'), alt: { type: 'slider', mode: 'volume' } })).status === 400, 'controle deslizante não pode ser ação ao segurar');
  check((await req('PUT', '/api/button/1/2', { label: 'C', action: wh('x'), alt: { type: 'ação-inexistente' } })).status === 400, 'ação alternativa inválida é recusada');
  check((await req('PUT', '/api/button/1/0', { label: 'A', action: wh('toque'), alt: null })).json?.ok === true && (await req('GET', '/api/config')).json.pages[0].buttons[0].alt === undefined, 'alt: null remove a ação ao segurar');
  await req('POST', '/api/press/0?long=1', undefined, true); check(hits.at(-1) === '/toque', 'removida: segurar volta a ser toque normal');

  console.log('\n== backup mantém a ação ao segurar');
  await req('PUT', '/api/button/1/0', { label: 'A', action: wh('toque'), alt: wh('segurar') });
  const bk = (await req('GET', '/api/backup')).json; check(bk.config.pages[0].buttons[0].alt?.url.endsWith('/segurar'), 'exportado com alt');
  await req('PUT', '/api/button/1/0', { label: '', action: null, alt: null }); check((await req('POST', '/api/backup', bk)).json?.ok === true && (await req('GET', '/api/config')).json.pages[0].buttons[0].alt?.url.endsWith('/segurar'), 'importado com alt');

  console.log('\n== deslizar troca de página');
  const p2 = await req('POST', '/api/page', { name: 'Segunda' }); check(p2.status === 200, 'segunda página criada');
  const cur = async () => (await req('GET', '/api/config')).json.current;
  const first = (await req('GET', '/api/config')).json.pages[0].id; await req('POST', `/api/current/${first}`);
  check((await req('POST', '/api/swipe/next')).status === 401, 'deslizar sem token: 401');
  const n = await req('POST', '/api/swipe/next', undefined, true); check(n.json?.ok === true && n.json.quiet === true && (await cur()) !== first, 'deslizar para a esquerda = próxima página (sem aviso na placa)');
  await req('POST', '/api/swipe/prev', undefined, true); check((await cur()) === first, 'deslizar para a direita = página anterior');
  await req('POST', '/api/swipe/prev', undefined, true); check((await cur()) !== first, 'anterior da primeira dá a volta (ciclo)');
}
main().then(() => { srv?.kill(); hook.close(); fs.rmSync(TMP, { recursive: true, force: true }); console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0); })
  .catch((e) => { srv?.kill(); hook.close(); console.error(e); process.exit(1); });
