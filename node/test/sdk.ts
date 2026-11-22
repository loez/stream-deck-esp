// Teste do SDK de plugins (../sdk/deck-plugin.mjs, protocolo v2) contra um host FALSO (WebSocket) escrito aqui, e da camada de compatibilidade com o Ulanzi (../sdk/ulanzi-compat.mjs).
// Não usa o servidor, a placa nem portas fixas (porta livre). Uso: npm run test:sdk
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { ROOT } from '../src/env.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sdk-'));
const ID = 'com.test.sdk', ACT = ID + '.btn';
fs.writeFileSync(path.join(TMP, 'plugin.json'), JSON.stringify({ id: ID, name: 'sdk', main: 'app.mjs', actions: [{ id: ACT, name: 'b' }] }));
for (const f of ['deck-plugin.mjs', 'ulanzi-compat.mjs']) fs.copyFileSync(path.join(ROOT, '..', 'sdk', f), path.join(TMP, f));
fs.writeFileSync(path.join(TMP, 'app.mjs'), `
import { Plugin } from './deck-plugin.mjs';
const plugin = new Plugin();
plugin.action('btn', {
  onAdd: (b) => b.set({ text: 'ola\\n' + (b.settings.n ?? 0) }),
  onPress: async (b) => { b.state.n = (b.state.n || 0) + 1; b.set({ image: 'data:image/png;base64,AAAA', text: 'n=' + b.state.n }); b.toast('toque ' + b.state.n); const g = await plugin.getGlobal(); b.save({ n: b.state.n, g: g.x }); },
  onSettings: (b, s) => b.set({ text: 'cfg ' + JSON.stringify(s) }),
  onActive: (b, a) => plugin.log('active ' + a),
  onMessage: (b, p) => { if (p.type === 'gif') b.set({ gif: Buffer.from('GIF89a') }); else if (p.type === 'gifFile') b.set({ gifFile: 'r/a.gif' }); else if (p.type === 'file') b.set({ imageFile: 'r/a.png' }); else if (p.type === 'png') b.set({ image: Buffer.from('PNG') }); else if (p.type === 'boom') throw new Error('x'); else if (p.type === 'misc') { plugin.openUrl('https://x.example', { a: '1' }); plugin.hotkey('cmd+k'); b.alert(); } else b.sendToUI({ type: 'eco', p }); },
  onDown: (b) => plugin.log('down'), onUp: (b) => plugin.log('up'),
  onRemove: (b) => plugin.log('removido ' + b.id),
});
`);
fs.writeFileSync(path.join(TMP, 'compat.mjs'), `
import UlanziApi from './ulanzi-compat.mjs';
const $UD = new UlanziApi();
$UD.connect(${JSON.stringify(ID)});
$UD.onAdd((j) => { $UD.setStateIcon(j.context, 0, 'oi'); $UD.setBaseDataIcon(j.context, 'data:image/png;base64,QQ==', 'txt'); });
$UD.onRun((j) => { $UD.toast('run ' + j.context + ' ' + JSON.stringify(j.param)); $UD.setSettings({ a: 1 }, j.context); });
$UD.onParamFromApp((j) => $UD.logMessage('pfa ' + JSON.stringify(j.param)));
$UD.onSendToPlugin((j) => $UD.sendToPropertyInspector({ eco: j.payload }, j.context));
$UD.onClear((j) => $UD.logMessage('clear ' + j.param[0].context));
`);

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => wss.once('listening', r));
const port = (wss.address() as { port: number }).port;
const got: any[] = []; let sock!: WebSocket;
wss.on('connection', (ws) => { sock = ws; ws.on('message', (raw) => got.push(JSON.parse(raw.toString()))); });
const host = (o: object) => sock.send(JSON.stringify(o));
const find = (f: (m: any) => boolean) => got.filter(f);
const waitFor = async (f: (m: any) => boolean, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = got.find(f); if (m) return m; await sleep(20); } return undefined; };
const logs = (re: RegExp) => got.some((m) => m.type === 'log' && re.test(m.message));

const child = spawn(process.execPath, ['app.mjs', '127.0.0.1', String(port)], { cwd: TMP, stdio: ['ignore', 'inherit', 'inherit'] });
const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
const B = { id: 'aaaaaaaa-0000-0000-0000-000000000001', action: ACT, key: '0_0' };
const set = (m: any) => m?.image;

console.log('\n== registro');
const hello = await waitFor((m) => m.type === 'hello');
check(hello?.protocol === 2 && hello.role === 'plugin' && hello.plugin === ID, 'registra com hello (protocolo 2, papel plugin, id do plugin.json)', JSON.stringify(hello));

console.log('\n== add');
host({ type: 'button.add', ...B, settings: { n: 5 } });
const s0 = await waitFor((m) => m.type === 'button.set');
check(s0?.id === B.id && s0.image.state === 0 && s0.text === 'ola\n5', 'onAdd: button.set com o ícone do plugin.json (state 0), o texto e a configuração salva', JSON.stringify(s0));

console.log('\n== toque');
got.length = 0;
host({ type: 'button.down', ...B }); host({ type: 'button.press', ...B, settings: { z: 1 } }); host({ type: 'button.up', ...B });
const toast = await waitFor((m) => m.type === 'toast');
check(toast?.message === 'toque 1', 'press -> onPress -> toast', JSON.stringify(toast));
check(logs(/^down$/) && (await waitFor((m) => m.type === 'log' && m.message === 'up')) !== undefined, 'down e up chegam');
const s1 = find((m) => m.type === 'button.set').at(-1);
check(s1?.image.data === 'data:image/png;base64,AAAA' && s1.text === 'n=1', 'set({image,text}) -> button.set com data', JSON.stringify(s1));
check(find((m) => m.type === 'global.get').length === 1, 'getGlobal() pede a configuração global');
host({ type: 'global.settings', settings: { x: 'G' } });
const ss = await waitFor((m) => m.type === 'button.settings.save');
check(ss?.id === B.id && ss.settings.n === 1 && ss.settings.g === 'G', 'getGlobal resolve e save() manda button.settings.save', JSON.stringify(ss));

console.log('\n== configuração, ativo, mensagens');
got.length = 0; host({ type: 'button.settings', ...B, settings: { cor: 'x' } });
const s2 = await waitFor((m) => m.type === 'button.set');
check(s2?.text === 'cfg {"cor":"x"}' && s2.image.data === 'data:image/png;base64,AAAA', 'onSettings recebe a nova configuração (o ícone anterior continua)', JSON.stringify(s2));
host({ type: 'button.active', ...B, active: false });
check(!!(await waitFor((m) => m.type === 'log' && m.message === 'active false')), 'button.active -> onActive(false)');
got.length = 0; host({ type: 'message', ...B, payload: { type: 'oi' } });
const pi = await waitFor((m) => m.type === 'ui.send');
check(pi?.id === B.id && pi.payload.type === 'eco' && pi.payload.p.type === 'oi', 'onMessage + sendToUI -> ui.send', JSON.stringify(pi));
for (const [t, want] of [['gif', { gif: Buffer.from('GIF89a').toString('base64') }], ['gifFile', { gifFile: 'r/a.gif' }], ['file', { file: 'r/a.png' }], ['png', { data: 'data:image/png;base64,' + Buffer.from('PNG').toString('base64') }]] as const) {
  got.length = 0; host({ type: 'message', ...B, payload: { type: t } });
  const s = await waitFor((m) => m.type === 'button.set');
  check(Object.entries(want).every(([k, v]) => set(s)?.[k] === v), `set({${t}}) -> button.set ${Object.keys(want)[0]}`, JSON.stringify(s));
}
got.length = 0; host({ type: 'message', ...B, payload: { type: 'misc' } });
check(!!(await waitFor((m) => m.type === 'open' && m.url === 'https://x.example' && m.params.a === '1')) && !!(await waitFor((m) => m.type === 'hotkey' && m.keys === 'cmd+k')) && !!(await waitFor((m) => m.type === 'button.alert' && m.id === B.id)), 'openUrl, hotkey e alert');
got.length = 0; host({ type: 'message', ...B, payload: { type: 'boom' } });
const lg = await waitFor((m) => m.type === 'log' && m.level === 'error');
check(!!lg && /x/.test(lg.message) && child.exitCode === null, 'erro dentro do tratador vai para o log e não derruba o plugin', JSON.stringify(lg));

console.log('\n== ulanzi-compat (UlanziApi e UlanziBridge sobre o SDK v2)');
{
  const ctx = `${ACT}___1_1___bbbbbbbb-0000-0000-0000-000000000002`, b2 = { id: 'bbbbbbbb-0000-0000-0000-000000000002', action: ACT, key: '1_1' };
  const first = sock;   // o host falso fala com a conexão mais recente: guarda a do plugin principal e volta a ela no fim
  const c2 = spawn(process.execPath, ['compat.mjs', '127.0.0.1', String(port)], { cwd: TMP, stdio: ['ignore', 'inherit', 'inherit'] });
  await waitFor((m) => m.type === 'hello' && m !== hello);
  got.length = 0; host({ type: 'button.add', ...b2, settings: {} });
  await sleep(300);
  const sts = find((m) => m.type === 'button.set');
  check(sts.length >= 2 && sts[0].id === b2.id && sts[0].image.state === 0 && sts[0].text === 'oi' && sts[1].image.data === 'data:image/png;base64,QQ==' && sts[1].text === 'txt', 'onAdd + setStateIcon/setBaseDataIcon (state do Ulanzi -> button.set)', JSON.stringify(sts));
  got.length = 0; host({ type: 'button.press', ...b2, settings: { k: 2 } });
  const t2 = await waitFor((m) => m.type === 'toast'), sv = await waitFor((m) => m.type === 'button.settings.save');
  check(t2?.message === 'run ' + ctx + ' {"k":2}', 'onRun entrega `context` e `param`; toast', JSON.stringify(t2));
  check(sv?.id === b2.id && sv.settings.a === 1, 'setSettings(settings, context) -> button.settings.save no botão certo', JSON.stringify(sv));
  got.length = 0; host({ type: 'button.settings', ...b2, settings: { w: 1 } });
  check(!!(await waitFor((m) => m.type === 'log' && m.message === 'pfa {"w":1}')), 'button.settings -> onParamFromApp');
  got.length = 0; host({ type: 'message', ...b2, payload: { q: 1 } });
  const pi2 = await waitFor((m) => m.type === 'ui.send');
  check(pi2?.id === b2.id && pi2.payload.eco.q === 1, 'onSendToPlugin -> sendToPropertyInspector(settings, context) -> ui.send', JSON.stringify(pi2));
  got.length = 0; host({ type: 'button.remove', ...b2 });
  check(!!(await waitFor((m) => m.type === 'log' && m.message === 'clear ' + ctx)), 'button.remove -> onClear com `context`');
  c2.kill(); sock = first;
}

console.log('\n== remover e sair');
got.length = 0; host({ type: 'button.remove', ...B });
check(!!(await waitFor((m) => m.type === 'log' && m.message.startsWith('removido'))), 'button.remove -> onRemove');
got.length = 0; host({ type: 'button.press', ...B });
await sleep(300);
check(find((m) => m.type === 'toast').length === 0, 'botão removido não recebe mais toques');
sock.close();
const code = await Promise.race([exited, sleep(3000).then(() => 'timeout')]);
check(code === 0, 'fechar a conexão do host encerra o plugin (código 0)', String(code));

child.kill(); wss.close(); fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + '='.repeat(60)); console.log(`${checks} verificações, ${fails.length} falha(s)`);
if (fails.length) { for (const f of fails) console.log('  FALHA:', f); process.exit(1); }
