// Teste das notificações do navegador (notify.ts + POST /api/notify + botão "Notificações" + página de histórico). Porta 8846.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const PORT = 8846, TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-nt-')), DATA = path.join(TMP, 'data');
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; raw: Buffer }> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length), 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
    const c: Buffer[] = []; res.on('data', (x) => c.push(x)); res.on('end', () => { const raw = Buffer.concat(c); let json: any = null; try { json = JSON.parse(raw.toString('utf8')); } catch { /* binário */ } resolve({ status: res.statusCode ?? 0, json, raw }); });
  });
  r.on('error', reject); r.end(b);
});
let srv: ChildProcess;

async function main() {
  section('servidor');
  fs.mkdirSync(DATA, { recursive: true });
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_DRYRUN: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await req('GET', '/api/config')).status === 200) break; } catch { /* sobe */ } await sleep(250); }
  const tk = (await req('GET', '/api/notify/token')).json.token as string;
  check(typeof tk === 'string' && tk.length >= 20, 'a página recebe a chave da extensão (GET /api/notify/token)');
  check((await req('GET', '/api/notify/token', undefined, { Origin: 'chrome-extension://abc' })).status === 403, 'a chave não é entregue a outra origem');
  const H = { 'X-Deck-Notify': tk };
  const post = (b: unknown, h: Record<string, string> = H) => req('POST', '/api/notify', b, h);

  section('POST /api/notify');
  check((await post({ title: 'x' }, {})).status === 401, 'sem chave: 401');
  check((await post({ title: 'x' }, { 'X-Deck-Notify': 'errada' + tk })).status === 401, 'chave errada: 401');
  check((await post({ title: 'x' }, { 'X-Deck-Notify': fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim() })).status === 401, 'o token da placa não vale aqui');
  check((await req('POST', '/api/notify', undefined, { ...H, 'Content-Type': 'text/plain' })).status === 400, 'tipo de conteúdo diferente de JSON: 400');
  check((await post({ title: '', body: '' })).status === 429, 'aviso vazio é descartado');
  let r = await post({ source: 'mail.google.com', title: 'Novo e-mail‮\n de Fulano', body: 'Olá, tudo bem? '.repeat(60), tag: 't1' });
  check(r.status === 200 && r.json.ok === true, 'aviso aceito');
  r = await req('GET', '/api/notifications');
  check(r.json.unread === 1 && r.json.items.length === 1, 'fila e não lidos', JSON.stringify(r.json).slice(0, 120));
  check(r.json.items[0].body.length <= 400 && !/[‮\n]/.test(r.json.items[0].title), 'texto limitado e sem caracteres de controle');
  await post({ source: 'mail.google.com', title: 'Segundo', tag: 't1' });
  check((await req('GET', '/api/notifications')).json.items.length === 1, 'mesma tag do mesmo site substitui o aviso');
  for (let k = 0; k < 4; k++) await post({ source: 's', title: 'aviso ' + k });
  check((await req('GET', '/api/status')).json.notif.unread === 5, '/api/status traz o contador de não lidos');

  section('botão Notificações e histórico');
  const S = (await req('GET', '/api/settings')).json, slotOf = (k: number) => Math.floor(k / S.cols) * S.stride + (k % S.cols);
  const put = (slot: number, action: unknown) => req('PUT', `/api/button/1/${slot}`, { label: '', action });
  check((await put(0, { type: 'widget', kind: 'notifications' })).status === 200, 'salvar o botão Notificações');
  const p0 = await req('GET', '/api/preview/1/0.png'); check(p0.status === 200 && p0.raw.length > 200, 'a prévia do botão é desenhada');
  const v0 = (await req('GET', '/api/status')).json.pv['1:0'];
  await post({ source: 'x', title: 'mais um' });
  const v1 = (await req('GET', '/api/status')).json.pv['1:0'];
  check(v1 > v0, 'aviso novo sobe a versão do botão (a placa redesenha)', `${v0} -> ${v1}`);
  r = await req('POST', '/api/test/1/0');
  check(r.status === 200 && r.json.ok === true, 'tocar no botão abre o histórico');
  let st = (await req('GET', '/api/status')).json;
  check(st.current === 900001 && st.notif.unread === 0, 'a página atual é o histórico e os avisos viram lidos', JSON.stringify([st.current, st.notif]));
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
  check(!cfg.pages.some((p: any) => p.id === 900001) && cfg.current !== 900001, 'o histórico nunca é gravado no config.json');
  const deck = (await req('GET', '/api/deck?cap=tiles', undefined, { 'X-Deck': fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim(), 'User-Agent': 'StreamDeckESP/1' })).json;
  check(deck?.buttons?.length > 4, '/api/deck serve a página de histórico');
  const img = await req('GET', `/api/preview/900001/${slotOf(4)}.png`); check(img.status === 200 && img.raw.length > 200, 'a mensagem é desenhada');
  check((await req('POST', '/api/test/900001/0')).json.ok === true, 'Voltar');
  st = (await req('GET', '/api/status')).json; check(st.current === 1, 'Voltar leva à página de origem', String(st.current));
  await req('POST', '/api/test/1/0');
  const n0 = (await req('GET', '/api/notifications')).json.items.length;
  await req('POST', `/api/test/900001/${slotOf(4)}`);   // tocar numa mensagem a dispensa
  check((await req('GET', '/api/notifications')).json.items.length === n0 - 1, 'tocar numa mensagem a dispensa');
  await req('POST', `/api/test/900001/${slotOf(2)}`); await req('POST', `/api/test/900001/${slotOf(1)}`);   // ▼ e ▲ não quebram
  await req('POST', `/api/test/900001/${slotOf(3)}`);
  check((await req('GET', '/api/notifications')).json.items.length === 0, 'Limpar apaga tudo');

  section('chave');
  const t2 = (await req('POST', '/api/notify/token/reset', {})).json.token;
  check(t2 !== tk && (await post({ title: 'a' })).status === 401 && (await post({ title: 'a' }, { 'X-Deck-Notify': t2 })).status === 200, 'gerar nova chave invalida a antiga');
}
main().catch((e) => { console.error('ERRO NO TESTE:', e); fails.push('erro: ' + e); }).finally(() => {
  srv?.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + '='.repeat(60) + `\n${checks} verificações, ${fails.length} falha(s)`);
  if (fails.length) { for (const x of fails) console.log('  FALHA: ' + x); process.exit(1); }
  process.exit(0);
});
