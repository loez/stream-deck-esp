// Teste do host com o protocolo v2 (formato nosso: plugin.json + SDK deck-plugin.mjs + deck-ui.js): plugin real escrito com o SDK, tela de configuração simulada (cliente WebSocket como o deck-ui.js),
// segurança (id forjado, Origin, segunda conexão), configuração do botão e global, importação de pasta .deckplugin e exemplo da documentação.
// Pastas temporárias, portas 8804 (HTTP) e 3918 (plugins), sem mDNS, dry-run. Uso: npm run test:deck
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { ROOT } from '../src/env.ts';

const SDK = path.join(ROOT, '..', 'sdk', 'deck-plugin.mjs'), EXAMPLE = path.join(ROOT, '..', 'docs', 'exemplo-plugin', 'ola-mundo.deckplugin');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-v2-'));
const DATA = path.join(TMP, 'data'), PLUGINS = path.join(TMP, 'plugins'), OUTSIDE = path.join(TMP, 'fora');
const HTTP_PORT = 8804, WS_PORT = 3918, TOKEN = 'deck-v2-test-token-0123456789abcdef', ID = 'com.test.deckv2', A_ECO = ID + '.eco';
const BOARD = { 'User-Agent': 'StreamDeckESP/1', 'X-Deck': TOKEN };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);

function writePlugin(root: string, id: string, name: string) {
  fs.mkdirSync(path.join(root, 'plugin'), { recursive: true }); fs.mkdirSync(path.join(root, 'pi'), { recursive: true });
  fs.copyFileSync(SDK, path.join(root, 'plugin', 'deck-plugin.mjs'));
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ id, name, version: '1.0.0', main: 'plugin/app.js', actions: [{ id: id + '.eco', name: 'Eco', ui: 'pi/index.html' }, { id: id + '.sem', name: 'Sem tela' }] }));
  fs.writeFileSync(path.join(root, 'pi', 'index.html'), '<!doctype html><title>pi</title><p>tela</p><script src="/deck-ui.js"></script>');
  fs.writeFileSync(path.join(root, 'config.json'), '{"segredo":"nao-servir"}');
  fs.writeFileSync(path.join(root, 'plugin', 'app.js'), `
import { Plugin } from './deck-plugin.mjs';
const plugin = new Plugin();
const COR = { azul: [40, 90, 220], verde: [30, 200, 60] };
const png = (rgb) => { const s = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="rgb(' + rgb.join(',') + ')"/></svg>'; return 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64'); };
const draw = (b, t) => b.set({ image: png(COR[b.settings.cor] || COR.azul), text: t ?? 'ECO' });
plugin.action('eco', {
  onAdd: (b) => { plugin.log('ADD ' + b.key + ' ' + JSON.stringify(b.settings)); draw(b); },
  onRemove: (b) => plugin.log('REMOVE ' + b.key),
  onActive: (b, a) => plugin.log('ACTIVE ' + b.key + ' ' + a),
  onDown: (b) => plugin.log('DOWN ' + b.key), onUp: (b) => plugin.log('UP ' + b.key),
  onPress: async (b) => { b.state.n = (b.state.n || 0) + 1; plugin.log('PRESS ' + JSON.stringify(b.settings)); draw(b, 'n=' + b.state.n); const g = await plugin.getGlobal(); plugin.setGlobal({ ...g, n: b.state.n }); b.toast('Executou ' + b.state.n); },
  onSettings: (b, s) => { plugin.log('SETTINGS ' + JSON.stringify(s)); draw(b); },
  onMessage: (b, p) => { plugin.log('MSG ' + JSON.stringify(p)); if (p.type === 'eco') b.sendToUI({ type: 'eco', p }); else if (p.type === 'salvar') b.save(p.settings); else if (p.type === 'hotkey') plugin.hotkey(p.keys); },
});
`);
}

// ---------- HTTP e servidor ----------
type Resp = { status: number; body: Buffer; json: any };
const req = (method: string, p: string, o: { body?: any; headers?: Record<string, string> } = {}): Promise<Resp> => new Promise((resolve, reject) => {
  const body = o.body === undefined ? undefined : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
  const r = http.request({ host: '127.0.0.1', port: HTTP_PORT, method, path: p, headers: { ...(body ? { 'Content-Length': String(body.length) } : {}), ...o.headers } }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const b = Buffer.concat(ch); let j: any; try { j = JSON.parse(b.toString('utf8')); } catch { /* binário */ } resolve({ status: res.statusCode || 0, body: b, json: j }); });
  });
  r.on('error', reject); r.end(body);
});
const until = async (what: string, fn: () => Promise<boolean>, ms = 9000): Promise<boolean> => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* de novo */ } await sleep(150); } check(false, `tempo esgotado: ${what}`); return false; };
let srv: ChildProcess;
function startServer(): Promise<void> {
  const env = { ...process.env, DECK_DATA: DATA, DECK_PORT: String(HTTP_PORT), DECK_PLUGIN_PORT: String(WS_PORT), DECK_PLUGINS_DIR: PLUGINS, DECK_ULANZI_DIR: path.join(TMP, 'nada'), DECK_NOMDNS: '1', DECK_DRYRUN: '1' };
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env, stdio: 'ignore' });
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
}
const info = async (id = ID) => (await req('GET', '/api/plugins')).json.plugins.find((p: any) => p.uuid === id);
const logHas = async (s: string, id = ID) => ((await info(id))?.log ?? []).some((l: string) => l.includes(s));
const raw = async (i: number) => (await req('GET', `/api/img/${i}.raw`, { headers: BOARD })).body;
const px = (buf: Buffer, x: number, y: number): [number, number, number] => { const o = (y * 73 + x) * 2, v = buf[o]! | (buf[o + 1]! << 8); return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31]; };

// ---------- tela de configuração simulada (o que o deck-ui.js faz no navegador) ----------
function ui(id: string, origin: string | null = `http://localhost:${HTTP_PORT}`) {
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`, origin ? { origin } : {}), got: any[] = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  const opened = new Promise<boolean>((res) => { ws.on('open', () => res(true)); ws.on('error', () => res(false)); ws.on('unexpected-response', () => res(false)); });
  const closed = new Promise<boolean>((res) => ws.on('close', () => res(true)));
  return { ws, got, opened, closed, send: (o: unknown) => ws.send(JSON.stringify(o)), hello: () => ws.send(JSON.stringify({ type: 'hello', protocol: 2, role: 'ui', id })) };
}
const waitMsg = async (got: any[], f: (m: any) => boolean, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = got.find(f); if (m) return m; await sleep(40); } return undefined; };

async function main() {
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 }); fs.mkdirSync(PLUGINS, { recursive: true });
  writePlugin(path.join(PLUGINS, 'teste.deckplugin'), ID, 'Teste v2');
  fs.cpSync(EXAMPLE, path.join(PLUGINS, 'ola-mundo.deckplugin'), { recursive: true });
  await startServer();

  section('1. descoberta (formato nosso: plugin.json) e arquivos servidos');
  const list = (await req('GET', '/api/plugins')).json.plugins;
  const me = list.find((p: any) => p.uuid === ID), ex = list.find((p: any) => p.uuid === 'com.exemplo.olamundo');
  check(me?.supported && me.name === 'Teste v2' && me.actions.length === 2 && me.actions[0].hasPI && !me.actions[1].hasPI, 'plugin .deckplugin é listado e suportado (2 ações, só a primeira com tela)', JSON.stringify(me));
  check(!!ex?.supported && ex.actions[0].hasPI, 'o exemplo da documentação (ola-mundo.deckplugin) também é listado');
  check(fs.readFileSync(path.join(EXAMPLE, 'plugin', 'deck-plugin.mjs'), 'utf8') === fs.readFileSync(SDK, 'utf8'), 'a cópia do SDK dentro do exemplo é igual a sdk/deck-plugin.mjs');
  check(fs.readFileSync(path.join(ROOT, 'web', 'deck-ui.js'), 'utf8') === (await req('GET', '/deck-ui.js')).body.toString('utf8') && (await req('GET', '/deck-ui.js')).status === 200, 'o app serve o SDK da tela de configuração em /deck-ui.js');
  check((await req('GET', '/plugins/teste.deckplugin/pi/index.html')).status === 200, 'tela do plugin é servida');
  for (const bad of ['config.json', 'plugin/../config.json', '..%2fola-mundo.deckplugin%2fplugin.json%2f..%2f..%2f..%2fdata%2ftoken']) check((await req('GET', '/plugins/teste.deckplugin/' + bad)).status === 404, `não serve "${bad}"`);

  section('2. atribuir, ícone e texto chegam à placa, toque');
  const a1 = await req('POST', '/api/button/1/0/plugin', { body: { plugin: ID, action: A_ECO } });
  check(a1.status === 200 && /^[0-9a-f-]{36}$/.test(a1.json?.actionid) && a1.json.pi?.url.includes('id=' + a1.json.actionid) && a1.json.pi.url.includes('plugin=' + ID) && !a1.json.pi.url.includes('controller='), 'atribuição devolve a tela com id/plugin/action (sem os parâmetros do legado)', a1.json?.pi?.url);
  const aid = a1.json?.actionid as string;
  await until('o plugin conectou e recebeu o botão', async () => (await info())?.ready && (await logHas('ADD 0_0')));
  check(await logHas('ACTIVE 0_0 true'), 'plugin recebe button.add e button.active');
  await sleep(600);
  { const b = await raw(0); const [r, g, bl] = px(b, 36, 20); check(bl > 150 && r < 90, 'ícone do plugin (azul) vira a imagem do botão', `px=${[r, g, bl]}`); }
  const t1 = await req('POST', '/api/test/1/0');
  check(t1.json?.ok && t1.json.msg === 'Executou 1', 'toque: button.press -> onPress -> toast volta como resultado', JSON.stringify(t1.json));
  check(await logHas('DOWN 0_0') && await logHas('UP 0_0') && await logHas('PRESS {}'), 'toque entrega down, press (com a configuração) e up');
  await until('global salvo', async () => fs.existsSync(path.join(DATA, 'plugin-settings', ID + '.json')));
  check(JSON.parse(fs.readFileSync(path.join(DATA, 'plugin-settings', ID + '.json'), 'utf8')).n === 1, 'configuração global (setGlobal/getGlobal) é guardada por plugin');

  section('3. tela de configuração (deck-ui): configuração, mensagens, salvar');
  const u = ui(aid); check(await u.opened, 'a tela conecta (Origin da própria página)'); u.hello();
  const first = await waitMsg(u.got, (m) => m.type === 'button.settings');
  check(first?.id === aid && first.action === A_ECO && JSON.stringify(first.settings) === '{}', 'ao abrir recebe button.settings com a configuração atual', JSON.stringify(first));
  u.send({ type: 'plugin.send', payload: { type: 'eco', x: 1 } });
  const eco = await waitMsg(u.got, (m) => m.type === 'message');
  check(eco?.payload?.type === 'eco' && eco.payload.p.x === 1, 'plugin.send -> onMessage -> sendToUI -> message na tela', JSON.stringify(eco));
  const uB = ui(aid); await uB.opened; uB.hello(); await waitMsg(uB.got, (m) => m.type === 'button.settings'); uB.got.length = 0;   // outra tela aberta do mesmo botão
  u.got.length = 0; u.send({ type: 'button.settings.save', settings: { cor: 'verde', titulo: 'oi' } });
  const echoed = await waitMsg(uB.got, (m) => m.type === 'button.settings');
  check(echoed?.settings?.cor === 'verde', 'salvar: as OUTRAS telas do botão recebem a configuração nova', JSON.stringify(echoed));
  await sleep(300); check(!u.got.some((m) => m.type === 'button.settings'), 'a tela que salvou não recebe o próprio eco (o formulário não volta atrás enquanto se digita)');
  uB.ws.close();
  await until('plugin recebeu a configuração', async () => await logHas('SETTINGS {"cor":"verde","titulo":"oi"}'));
  const saved = (await req('GET', '/api/config')).json.pages.flatMap((p: any) => p.buttons).find((b: any) => b.action?.actionid === aid);
  check(saved?.action?.settings?.cor === 'verde', 'a configuração do botão vai para o config.json');
  await sleep(600);
  { const b = await raw(0); const [r, g, bl] = px(b, 36, 20); check(g > 150 && bl < 120, 'o plugin redesenha com a nova configuração (ícone verde)', `px=${[r, g, bl]}`); }
  u.got.length = 0; u.send({ type: 'plugin.send', payload: { type: 'salvar', settings: { cor: 'azul' } } });
  check(!!(await waitMsg(u.got, (m) => m.type === 'button.settings' && m.settings.cor === 'azul')), 'o plugin salva (b.save) e a tela recebe a mudança');
  u.send({ type: 'global.get' }); check((await waitMsg(u.got, (m) => m.type === 'global.settings'))?.settings?.n === 1, 'global.get pela tela devolve a configuração global do plugin');

  section('4. segurança');
  const u2 = ui('00000000-0000-0000-0000-000000000000'); await u2.opened; u2.hello(); check(await Promise.race([u2.closed, sleep(2000).then(() => false)]), 'tela com id de botão inexistente: fechada');
  const u3 = ui(aid, 'http://evil.example'); check(!(await u3.opened), 'tela vinda de outro site (Origin): recusada');
  const dup = new WebSocket(`ws://127.0.0.1:${WS_PORT}`); await new Promise((r) => dup.on('open', r)); dup.send(JSON.stringify({ type: 'hello', protocol: 2, role: 'plugin', plugin: ID }));
  check(await Promise.race([new Promise<boolean>((r) => dup.on('close', () => r(true))), sleep(2000).then(() => false)]), 'um segundo processo se anunciando com o id do plugin: recusado (a primeira conexão vence)');
  check((await info())?.ready === true, 'o plugin verdadeiro continua conectado');
  const fake = new WebSocket(`ws://127.0.0.1:${WS_PORT}`); await new Promise((r) => fake.on('open', r)); fake.send(JSON.stringify({ type: 'hello', protocol: 2, role: 'plugin', plugin: 'com.nao.iniciado' }));
  check(await Promise.race([new Promise<boolean>((r) => fake.on('close', () => r(true))), sleep(2000).then(() => false)]), 'plugin que o app não iniciou: recusado');
  { // a tela só mexe no PRÓPRIO botão: mensagem com o id de outro é tratada como do dela
    const a2 = (await req('POST', '/api/button/1/1/plugin', { body: { plugin: ID, action: A_ECO } })).json.actionid as string; await until('2º botão', async () => await logHas('ADD 1_0'));
    u.got.length = 0; u.send({ type: 'button.settings.save', id: a2, settings: { cor: 'verde' } }); await sleep(600);
    const cfgBtns = (await req('GET', '/api/config')).json.pages.flatMap((p: any) => p.buttons).filter((b: any) => b.action?.plugin === ID);
    check(cfgBtns.find((b: any) => b.action.actionid === a2)?.action.settings?.cor !== 'verde' && cfgBtns.find((b: any) => b.action.actionid === aid)?.action.settings?.cor === 'verde', 'tela não consegue gravar a configuração de outro botão (id na mensagem é ignorado)');
  }
  u.ws.close();

  section('5. desatribuir, importar pasta .deckplugin, apagar');
  await req('PUT', '/api/button/1/1', { body: { action: null } });
  await until('plugin recebeu button.remove', async () => await logHas('REMOVE 1_0'));
  writePlugin(path.join(OUTSIDE, 'novo'), 'com.test.novo', 'Novo');
  const imp = await req('POST', '/api/plugins/import', { body: { path: path.join(OUTSIDE, 'novo') } });
  check(imp.status === 200 && imp.json.dir === 'novo.deckplugin' && fs.existsSync(path.join(PLUGINS, 'novo.deckplugin', 'plugin.json')), 'importar uma pasta com plugin.json: instalada como .deckplugin', JSON.stringify(imp.json));
  check((await req('POST', '/api/plugins/import', { body: { path: path.join(OUTSIDE, 'novo') } })).status === 400, 'importar de novo o mesmo plugin: recusado');
  fs.mkdirSync(path.join(OUTSIDE, 'ruim'), { recursive: true }); fs.writeFileSync(path.join(OUTSIDE, 'ruim', 'plugin.json'), JSON.stringify({ id: 'x', name: 'x', main: '../fora.js', actions: [{ id: 'x.a', name: 'a' }] }));
  check((await req('POST', '/api/plugins/import', { body: { path: path.join(OUTSIDE, 'ruim') } })).status === 400, 'main fora da pasta do plugin: recusado');
  const del = await req('DELETE', '/api/plugins/' + encodeURIComponent(ID));
  check(del.status === 200 && del.json.cleared >= 1 && !fs.existsSync(path.join(PLUGINS, 'teste.deckplugin')), 'apagar o plugin remove a pasta e limpa os botões', JSON.stringify(del.json));

  srv.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + '='.repeat(60)); console.log(`${checks} verificações, ${fails.length} falha(s)`);
  if (fails.length) { for (const f of fails) console.log('  FALHA:', f); process.exit(1); }
}
main().catch((e) => { console.error(e); try { srv?.kill(); } catch { /* */ } process.exit(1); });
