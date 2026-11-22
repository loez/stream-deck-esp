// Teste da troca automática de página pelo app em foco (src/focus.ts). O app "em foco" é simulado por um arquivo (DECK_FRONT_FILE) para o teste ser determinístico;
// uma verificação à parte (npm run test:focus-real, manual) usa o foco real do macOS.
// Pastas temporárias, porta 8805, sem mDNS, sem plugins.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-focus-')), DATA = path.join(TMP, 'data'), FRONT = path.join(TMP, 'front'), PORT = 8805, TOKEN = 'focus-test-token-0123456789abcdefgh';
const BOARD = { 'User-Agent': 'StreamDeckESP/1', 'X-Deck': TOKEN };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);

type Resp = { status: number; json: any };
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length) } : {}), ...headers } }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { let j: any; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode || 0, json: j }); });
  });
  r.on('error', reject); r.end(b);
});
const setFront = (bundle: string, name = bundle) => fs.writeFileSync(FRONT, `${bundle}|${name}`);
const current = async () => (await req('GET', '/api/status')).json.current as number;
const deckHeader = async () => (await req('GET', '/api/deck', undefined, BOARD)).json.page as string;
const until = async (what: string, fn: () => Promise<boolean>, ms = 4000): Promise<boolean> => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* */ } await sleep(120); } return false; };
let srv: ChildProcess;
function start(): Promise<void> {
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_FRONT_FILE: FRONT, DECK_DRYRUN: '1' } });
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 }); setFront('com.test.neutro', 'Neutro');
  await start();
  const mk = async (name: string) => (await req('POST', '/api/page', { name })).json.id as number;
  const P1 = 1, PD = await mk('Discord'), PS = await mk('Safari'), PX = await mk('Outra');   // página 1 = "Principal"

  section('1. vínculos: validação e persistência');
  const ok1 = await req('PUT', `/api/page/${PD}`, { apps: [{ name: 'Discord', bundle: 'com.hnc.Discord' }, { name: 'Discord', bundle: 'com.hnc.Discord' }, { name: 'Discord PTB', bundle: 'com.hnc.Discord.PTB' }] });
  const cfg = (await req('GET', '/api/config')).json, pd = cfg.pages.find((p: any) => p.id === PD);
  check(ok1.status === 200 && pd.apps.length === 2 && pd.apps[0].bundle === 'com.hnc.Discord', 'vincula apps à página (duplicados são ignorados)', JSON.stringify(pd.apps));
  await req('PUT', `/api/page/${PS}`, { apps: [{ name: 'Safari', bundle: 'com.apple.Safari' }] });
  if (fs.existsSync('/System/Applications/Calculator.app')) {   // só no macOS (lê o Info.plist do app real)
    const viaPath = await req('PUT', `/api/page/${PX}`, { apps: [{ name: 'Calculadora', path: '/System/Applications/Calculator.app' }] });
    check(viaPath.status === 200 && (await req('GET', '/api/config')).json.pages.find((p: any) => p.id === PX).apps[0].bundle === 'com.apple.calculator', 'bundle id é descoberto a partir do caminho do .app (Info.plist)');
  }
  await req('PUT', `/api/page/${PX}`, { apps: [] });
  check((await req('GET', '/api/config')).json.pages.find((p: any) => p.id === PX).apps === undefined, 'lista vazia remove o vínculo (o campo some do config.json)');
  for (const [l, body] of [['apps não é lista', { apps: 'x' }], ['mais de 10 apps', { apps: Array.from({ length: 11 }, (_, k) => ({ name: 'a' + k })) }], ['item não é objeto', { apps: ['x'] }], ['app sem nome', { apps: [{ name: '  ' }] }]] as [string, unknown][]) {
    const r = await req('PUT', `/api/page/${PD}`, body); check(r.status === 400, `recusa: ${l}`, r.json?.erro);
  }
  check((await req('GET', '/api/config')).json.pages.find((p: any) => p.id === PD).apps.length === 2, 'pedido inválido não altera os vínculos');

  section('2. o app entra em foco: a placa mostra a página dele; ao sair, volta à anterior');
  await req('POST', `/api/current/${PX}`);   // página de partida: "Outra"
  setFront('com.hnc.Discord', 'Discord');
  check(await until('trocar para Discord', async () => (await current()) === PD), 'Discord em foco -> página "Discord"');
  check((await deckHeader()).startsWith('Discord'), 'o cabeçalho que a placa recebe mostra a página nova', await deckHeader());
  const st = (await req('GET', '/api/status')).json; check(st.front?.bundle === 'com.hnc.Discord' && st.on === true && st.enabled === true, 'status informa o app em foco e que a página é automática', JSON.stringify({ f: st.front, on: st.on }));
  setFront('com.apple.Safari', 'Safari');
  check(await until('ir para Safari', async () => (await current()) === PS), 'Safari em foco -> página "Safari" (de uma página vinculada direto para outra)');
  setFront('com.test.neutro', 'Neutro');
  check(await until('voltar', async () => (await current()) === PX), 'app sem vínculo -> volta para a página de ANTES de tudo ("Outra"), não para a anterior da cadeia');
  check((await req('GET', '/api/status')).json.on === false, 'status: automático desligado depois de voltar');

  section('3. escolha manual vale até o próximo app; apps passageiros do sistema são ignorados');
  setFront('com.hnc.Discord', 'Discord'); await until('Discord', async () => (await current()) === PD);
  await req('POST', `/api/current/${P1}`);   // o usuário escolhe outra página à mão (toque na placa ou página)
  await sleep(1500);
  check((await current()) === P1, 'com o MESMO app em foco, a escolha manual não é desfeita');
  setFront('com.apple.dock', 'Dock'); await sleep(1500);
  check((await current()) === P1, 'Dock/Spotlight (passageiros) não contam como troca de app');
  setFront('com.apple.spotlight', 'Spotlight'); await sleep(1200); setFront('com.hnc.Discord', 'Discord'); await sleep(1200);
  check((await current()) === P1, 'voltar ao mesmo app depois de um passageiro não força a página de novo');
  setFront('com.test.neutro', 'Neutro'); check(await until('restaurar', async () => (await current()) === PX), 'ao sair do app, volta à página que estava antes do vínculo', String(await current()));

  section('4. interruptor, edição de vínculos e páginas apagadas');
  await req('POST', '/api/autoswitch', { enabled: false });
  check((await req('GET', '/api/config')).json.autoswitch === false && (await req('GET', '/api/status')).json.enabled === false, 'desligar grava autoswitch:false e o status reflete');
  setFront('com.apple.Safari', 'Safari'); await sleep(1500);
  check((await current()) === PX, 'com a troca automática desligada, o app em foco não muda a página');
  await req('POST', '/api/autoswitch', { enabled: true });
  check(await until('ligar com app vinculado em foco', async () => (await current()) === PS), 'ao ligar, se o app em foco já tem página, ela é mostrada');
  await req('POST', '/api/autoswitch', { enabled: false });
  check(await until('desligar com automático ativo', async () => (await current()) === PX), 'ao desligar com a página automática ativa, volta à página anterior');
  check((await req('GET', '/api/config')).json.autoswitch === false, 'o interruptor fica gravado'); await req('POST', '/api/autoswitch', { enabled: true });
  await req('PUT', `/api/page/${PS}`, { apps: [] });
  setFront('com.test.neutro', 'Neutro'); await sleep(900);
  await req('PUT', `/api/page/${PS}`, { apps: [{ name: 'Safari', bundle: 'com.apple.Safari' }] }); setFront('com.apple.Safari', 'Safari');
  check(await until('Safari', async () => (await current()) === PS), 'vínculo recriado volta a funcionar');
  await req('DELETE', `/api/page/${PX}`);   // apaga a página para onde ele voltaria
  setFront('com.test.neutro', 'Neutro');
  check(await until('fallback', async () => (await current()) === P1), 'se a página de retorno foi apagada, cai na primeira página');
  await req('POST', `/api/current/${PS}`); setFront('com.apple.Safari', 'Safari'); await sleep(300);
  await req('PUT', `/api/page/${PS}`, { apps: [{ name: 'Safari', bundle: 'COM.APPLE.SAFARI' }] }); setFront('com.test.neutro', 'N'); setFront('com.apple.safari', 'safari');
  check(await until('bundle em outra caixa', async () => (await current()) === PS), 'bundle id é comparado sem diferenciar maiúsculas');

  section('5. vários vínculos, vínculo só por nome, reinício');
  await req('PUT', `/api/page/${P1}`, { apps: [{ name: 'Terminal' }] });   // sem bundle: vale pelo nome
  setFront('com.apple.Terminal', 'Terminal');
  check(await until('Terminal por nome', async () => (await current()) === P1), 'app vinculado só pelo nome (sem bundle id) é reconhecido');
  await req('PUT', `/api/page/${PD}`, { apps: [{ name: 'Terminal', bundle: 'com.apple.Terminal' }] });   // dois vínculos para o mesmo app: vence a página que vem primeiro
  setFront('com.test.neutro', 'N'); await sleep(900); setFront('com.apple.Terminal', 'Terminal');
  await sleep(1200); check((await current()) === P1, 'dois vínculos para o mesmo app: vence a primeira página na ordem');
  srv.kill('SIGTERM'); await sleep(700); await start();
  const after = (await req('GET', '/api/config')).json;
  check(after.pages.find((p: any) => p.id === P1).apps[0].name === 'Terminal' && after.pages.find((p: any) => p.id === PD).apps[0].bundle === 'com.apple.Terminal', 'os vínculos sobrevivem ao reinício do servidor');

  console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); fails.forEach((f) => console.log(' -', f));
}
main().catch((e) => { console.error('ERRO NO TESTE:', e); fails.push('erro: ' + e); }).finally(() => { srv?.kill('SIGTERM'); setTimeout(() => { fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails.length ? 1 : 0); }, 500); });
