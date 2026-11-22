// Teste do host de plugins (src/plugins.ts) com um plugin FALSO escrito aqui (protocolo do Ulanzi Studio) e uma "tela de configuração" simulada por um cliente WebSocket.
// Não toca nos plugins reais nem na placa: pastas temporárias, portas 8803 (HTTP) e 3917 (plugins), sem mDNS, dry-run (comandos do macOS só impressos).
// Uso: npm run test:plugins
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import zlib from 'node:zlib';

/** Escreve um .zip (sem compressão) com todos os arquivos de dir, dentro da pasta `top`. */
function writeZip(out: string, dir: string, top: string): void {
  const files: [string, Buffer][] = [];
  const walk = (d: string, rel: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = rel + '/' + e.name; let st: fs.Stats; try { st = fs.statSync(p); } catch { continue; } if (st.isDirectory()) walk(p, r); else files.push([r, fs.readFileSync(p)]); } };
  walk(dir, top);
  const parts: Buffer[] = [], central: Buffer[] = []; let off = 0;
  for (const [name, data] of files) {
    const nm = Buffer.from(name), crc = zlib.crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nm, data); central.push(c, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(out, Buffer.concat([...parts, cd, end]));
}
import type { ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { GifWriter } from 'omggif';
import { ROOT } from '../src/env.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugins-'));
const DATA = path.join(TMP, 'data'), PLUGINS = path.join(TMP, 'plugins'), ULANZI = path.join(TMP, 'ulanzi');
const HTTP_PORT = 8803, WS_PORT = 3917, TOKEN = 'plugin-test-token-0123456789abcdef';
const MAIN = 'com.test.ulanzistudio.fake', A_COLOR = MAIN + '.color', A_NOPI = MAIN + '.nopi', A_GIF = MAIN + '.gif';
// GIF de 2 quadros (vermelho 10 cs, verde 10 cs) que o plugin falso manda como ícone animado (estado tipo 3)
const GIF_B64 = (() => { const buf = Buffer.alloc(4096), gw = new GifWriter(buf, 16, 16, { palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff] }); for (const c of [1, 2]) gw.addFrame(0, 0, 16, 16, new Uint8Array(256).fill(c), { delay: 10 }); return buf.subarray(0, gw.end()).toString('base64'); })();
const BOARD = { 'User-Agent': 'StreamDeckESP/1', 'X-Deck': TOKEN };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);

// ---------- o plugin falso ----------
function writeFakePlugin(root: string, mainUuid: string, name: string, codePath = 'plugin/app.js') {
  fs.mkdirSync(path.join(root, 'plugin'), { recursive: true }); fs.mkdirSync(path.join(root, 'pi'), { recursive: true }); fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));   // o plugin usa "ws" e o canvas do projeto
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    Name: name, UUID: mainUuid, Version: '1.0.0', Author: 'teste', Type: 'JavaScript', CodePath: codePath,
    Actions: [{ Name: 'Cor', UUID: mainUuid + '.color', PropertyInspectorPath: 'pi/index.html', States: [{ Name: 'Default', Image: 'resources/s0.png' }] }, { Name: 'Sem tela', UUID: mainUuid + '.nopi' }, { Name: 'Gif', UUID: mainUuid + '.gif' }],
  }));
  fs.writeFileSync(path.join(root, 'pi', 'index.html'), '<!doctype html><title>pi</title><p>tela do plugin falso</p>');
  fs.writeFileSync(path.join(root, 'config.json'), '{"segredo":"nao-servir"}'); fs.writeFileSync(path.join(root, 'key.pem'), 'SEGREDO');
  if (codePath === 'plugin/app.js') fs.writeFileSync(path.join(root, 'plugin', 'app.js'), `
import WebSocket from 'ws'; import { createCanvas } from '@napi-rs/canvas';
const [, , addr, port] = process.argv, MAIN = ${JSON.stringify(mainUuid)};
const ws = new WebSocket('ws://' + addr + ':' + port), btn = new Map(); let n = 0;
const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const ctxOf = (m) => m.uuid + '___' + m.key + '___' + m.actionid;
function icon(color, txt) { const c = createCanvas(144, 144), g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 144, 144); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(txt, 20, 90); return 'data:image/png;base64,' + c.toBuffer('image/png').toString('base64'); }
function draw(b, text) { if (b.uuid === MAIN + '.gif') { send({ cmd: 'state', uuid: MAIN, key: '', actionid: '', param: { statelist: [{ uuid: b.uuid, key: b.key, actionid: b.actionid, type: 3, gifdata: ${JSON.stringify(GIF_B64)} }] } }); return; } const color = (b.settings && b.settings.color) || '#e22'; send({ cmd: 'state', uuid: MAIN, key: '', actionid: '', param: { statelist: [{ uuid: b.uuid, key: b.key, actionid: b.actionid, type: 1, data: icon(color, String(b.count || 0)), textData: text ?? 'FAKE\\nOK', showtext: true }] } }); }
ws.on('open', () => send({ code: 0, cmd: 'connected', uuid: MAIN }));
ws.on('close', () => process.exit(0));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString()); send({ code: 0, ...m });   // o SDK confirma cada comando do host
  const ctx = ctxOf(m); const b = btn.get(ctx);
  switch (m.cmd) {
    case 'add': { const nb = { uuid: m.uuid, key: m.key, actionid: m.actionid, settings: m.param || {}, count: 0 }; btn.set(ctx, nb); console.log('ADD ' + m.key + ' ' + JSON.stringify(nb.settings)); draw(nb); break; }
    case 'setactive': console.log('ACTIVE ' + m.key + ' ' + m.active); break;
    case 'clear': for (const it of m.param || []) { btn.delete(it.uuid + '___' + it.key + '___' + it.actionid); console.log('CLEAR ' + it.key); } break;
    case 'keydown': console.log('KEYDOWN ' + m.key); break;
    case 'keyup': console.log('KEYUP ' + m.key); break;
    case 'run': if (b) { b.count++; console.log('RUN ' + m.key + ' ' + b.count + ' ' + JSON.stringify(m.param)); draw(b, 'n=' + b.count + ' \\u21bb'); send({ cmd: 'toast', uuid: MAIN, key: '', actionid: '', msg: 'Executou ' + b.count }); } break;
    case 'paramfromapp': if (b) { b.settings = m.param || {}; console.log('PARAMFROMAPP ' + JSON.stringify(b.settings)); draw(b); } break;
    case 'didReceiveSettings': if (b) { b.settings = m.settings || {}; console.log('SETTINGS ' + JSON.stringify(b.settings)); draw(b); } break;
    case 'didReceiveGlobalSettings': console.log('GLOBAL ' + JSON.stringify(m.settings)); break;
    case 'sendToPlugin': { const p = m.payload || {};
      if (p.type === 'getConfig') send({ cmd: 'sendToPropertyInspector', uuid: m.uuid, key: m.key, actionid: m.actionid, payload: { type: 'config', settings: b ? b.settings : null } });
      else if (p.type === 'save') send({ cmd: 'setSettings', uuid: m.uuid, key: m.key, actionid: m.actionid, settings: p.config });
      else if (p.type === 'hotkey') send({ cmd: 'hotkey', keylist: p.keylist });
      else if (p.type === 'url') send({ cmd: 'openurl', url: p.url, local: !!p.local, param: p.param || null });
      else if (p.type === 'global') { send({ cmd: 'setGlobalSettings', uuid: MAIN, settings: { token: 'g1' } }); send({ cmd: 'getGlobalSettings', uuid: MAIN }); }
      break; }
  }
});`);
}

// ---------- HTTP ----------
type Resp = { status: number; body: Buffer; json: any };
const showText = (pid: number, slot: number, plugin: string, action: string, actionid: string, on = true) => req('PUT', `/api/button/${pid}/${slot}`, { body: { action: { type: 'plugin', plugin, action, actionid, ...(on ? { showText: true } : {}) } } });   // "mostrar texto do plugin" (padrão: desligado)
const req = (method: string, p: string, o: { body?: any; headers?: Record<string, string> } = {}): Promise<Resp> => new Promise((resolve, reject) => {
  const body = o.body === undefined ? undefined : Buffer.from(typeof o.body === 'string' || Buffer.isBuffer(o.body) ? o.body : JSON.stringify(o.body));
  const r = http.request({ host: '127.0.0.1', port: HTTP_PORT, method, path: p, headers: { ...(body ? { 'Content-Length': String(body.length) } : {}), ...o.headers } }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const b = Buffer.concat(ch); let j: any; try { j = JSON.parse(b.toString('utf8')); } catch { /* binário */ } resolve({ status: res.statusCode || 0, body: b, json: j }); });
  });
  r.on('error', reject); r.end(body);
});
const until = async (what: string, fn: () => Promise<boolean>, ms = 9000): Promise<boolean> => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* tenta de novo */ } await sleep(150); } check(false, `tempo esgotado: ${what}`); return false; };
const deck = async () => (await req('GET', '/api/deck', { headers: BOARD })).json;
const raw = async (i: number) => (await req('GET', `/api/img/${i}.raw`, { headers: BOARD })).body;
const px = (buf: Buffer, x: number, y: number): [number, number, number] => { const o = (y * 73 + x) * 2, v = buf[o]! | (buf[o + 1]! << 8); return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31]; };

// ---------- servidor ----------
let srv: ChildProcess; const srvLog: string[] = [];
function startServer(extraEnv: Record<string, string> = {}): Promise<void> {
  const env = { ...process.env, DECK_DATA: DATA, DECK_PORT: String(HTTP_PORT), DECK_PLUGIN_PORT: String(WS_PORT), DECK_PLUGINS_DIR: PLUGINS, DECK_ULANZI_DIR: ULANZI, DECK_NOMDNS: '1', DECK_DRYRUN: '1', PYTHONUNBUFFERED: '1', ...extraEnv };
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env });
  let partial = ''; for (const s of [srv.stdout!, srv.stderr!]) s.on('data', (d) => { partial += String(d); const parts = partial.split('\n'); partial = parts.pop()!; parts.filter(Boolean).forEach((l) => srvLog.push(l)); });
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
}
const pluginInfo = async () => (await req('GET', '/api/plugins')).json.plugins.find((p: any) => p.uuid === MAIN);
const logHas = async (s: string) => ((await pluginInfo())?.log ?? []).some((l: string) => l.includes(s));
const cfg = async () => (await req('GET', '/api/config')).json;

// ---------- tela de configuração simulada (cliente WebSocket como o do navegador) ----------
function piClient(uuid: string, key: string, actionid: string, origin: string | null = `http://localhost:${HTTP_PORT}`) {
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`, origin ? { origin } : {}), got: any[] = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  const opened = new Promise<boolean>((res) => { ws.on('open', () => res(true)); ws.on('error', () => res(false)); ws.on('unexpected-response', () => res(false)); });
  return { ws, got, opened, send: (o: unknown) => ws.send(JSON.stringify(o)), hello: () => ws.send(JSON.stringify({ code: 0, cmd: 'connected', uuid, key, actionid })) };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 }); fs.mkdirSync(PLUGINS, { recursive: true }); fs.mkdirSync(ULANZI, { recursive: true });
  writeFakePlugin(path.join(PLUGINS, 'com.test.fake.ulanziPlugin'), MAIN, 'Fake');
  writeFakePlugin(path.join(PLUGINS, 'com.test.html.ulanziPlugin'), 'com.test.ulanzistudio.htmlonly', 'SoHtml', 'plugin/app.html');   // serviço principal em HTML: não suportado
  await startServer();

  section('1. descoberta e arquivos estáticos');
  const list = (await req('GET', '/api/plugins')).json;
  check(list.enabled && list.plugins.length === 2, 'dois plugins instalados são listados', JSON.stringify(list.plugins.map((p: any) => p.name)));
  const fake = list.plugins.find((p: any) => p.uuid === MAIN), html = list.plugins.find((p: any) => p.name === 'SoHtml');
  check(fake?.supported === true && fake.actions.length === 3 && fake.actions[0].hasPI && !fake.actions[1].hasPI, 'plugin Node: suportado, 3 ações (cor, sem tela, GIF), só a primeira tem tela de configuração');
  { const { lanBlocked } = await import('../src/plugins.ts'); const L = '[Rede] EHOSTUNREACH 192.168.31.230:6466';
    check(lanBlocked([L, L, L]) && !lanBlocked([L, L]) && !lanBlocked(['EHOSTUNREACH 8.8.8.8:443', 'EHOSTUNREACH 8.8.8.8:443', 'EHOSTUNREACH 8.8.8.8:443']) && lanBlocked(['connect 10.0.0.5:6466 EHOSTUNREACH', 'a 10.0.0.5:6466 EHOSTUNREACH', 'b 10.0.0.5:6466 EHOSTUNREACH']), 'rede local bloqueada: 3+ EHOSTUNREACH para IP privado marcam o aviso; IP público ou só 2 erros, não'); }
  check(html?.supported === false && /HTML|Node/.test(html.why), 'plugin com serviço em HTML: marcado como não suportado', html?.why);
  const base = '/plugins/com.test.fake.ulanziPlugin/';
  check((await req('GET', base + 'pi/index.html')).status === 200, 'tela do plugin é servida');
  for (const bad of ['config.json', 'key.pem', 'package.json', '..%2fcom.test.html.ulanziPlugin%2fmanifest.json', '..%2f..%2fdata%2ftoken', '%2e%2e/%2e%2e/data/token', 'node_modules/ws/package.json', 'plugin/app.js/../../../../etc/passwd']) {
    const r = await req('GET', base + bad); check(r.status === 404, `não serve "${bad}"`, `status ${r.status}`);
  }
  check((await req('GET', base + 'pi/index.html', { headers: { Host: 'evil.com' } })).status === 403, 'tela do plugin: Host malicioso é recusado');

  section('2. atribuir a ação a um botão: ícone e texto do plugin chegam à placa');
  const bad1 = await req('POST', '/api/button/1/0/plugin', { body: { plugin: 'nao.existe', action: 'x' } }); check(bad1.status === 400, 'plugin inexistente: recusado', bad1.json?.erro);
  const bad2 = await req('POST', '/api/button/1/0/plugin', { body: { plugin: 'com.test.ulanzistudio.htmlonly', action: 'com.test.ulanzistudio.htmlonly.color' } }); check(bad2.status === 400 && /suportado/.test(bad2.json?.erro), 'plugin não suportado: recusado', bad2.json?.erro);
  const noSave = await req('PUT', '/api/button/1/1', { body: { action: { type: 'plugin' } } }); check(noSave.status === 400 && /escolha/.test(noSave.json.erro), 'salvar "plugin" sem escolher a ação: recusado', noSave.json?.erro);
  const forged = await req('PUT', '/api/button/1/1', { body: { action: { type: 'plugin', plugin: MAIN, action: A_COLOR, actionid: 'nao-e-uuid' } } }); check(forged.status === 400, 'actionid forjado: recusado', forged.json?.erro);
  const a1 = await req('POST', '/api/button/1/0/plugin', { body: { plugin: MAIN, action: A_COLOR } });
  check(a1.status === 200 && /^[0-9a-f-]{36}$/.test(a1.json.actionid) && a1.json.pi?.url?.includes('uuid=' + A_COLOR) && a1.json.pi.url.includes('key=0_0'), 'atribuição devolve actionid e a URL da tela de configuração', JSON.stringify(a1.json));
  const actionid: string = a1.json.actionid;
  check(JSON.stringify((await cfg()).pages[0].buttons[0].action) === JSON.stringify({ type: 'plugin', plugin: MAIN, action: A_COLOR, actionid, settings: {} }), 'config.json guarda plugin, ação, actionid e settings');
  await until('plugin conectar e mandar o ícone', async () => (await pluginInfo()).ready);
  await sleep(600); check((await deck()).buttons[0].label === '', 'por padrão o texto do plugin NÃO aparece na placa (sem título, sem "mostrar texto")');
  check((await showText(1, 0, MAIN, A_COLOR, actionid)).status === 200, 'marcar "mostrar texto do plugin" salva');
  check(JSON.stringify((await cfg()).pages[0].buttons[0].action) === JSON.stringify({ type: 'plugin', plugin: MAIN, action: A_COLOR, actionid, settings: {}, showText: true }), 'config.json guarda showText e mantém as configurações do plugin');
  await until('texto do plugin aparecer', async () => (await deck()).buttons[0].label === 'FAKE\nOK');
  const d0 = await deck();
  check(d0.buttons[0].label === 'FAKE\nOK' && d0.buttons[0].fs === 12, 'texto do plugin com quebra de linha preservada', JSON.stringify(d0.buttons[0]));
  const img0 = await raw(0), [r0, g0, b0] = px(img0, 10, 20);
  check(r0 > 180 && g0 < 90 && b0 < 90, 'ícone do plugin (vermelho) está na imagem enviada à placa', `RGB ${[r0, g0, b0].map(Math.round)}`);
  check((await pluginInfo()).ready, 'plugin aparece como pronto');
  check(await logHas('ADD 0_0 {}'), 'plugin recebeu add com as configurações salvas ({})');
  check(await logHas('ACTIVE 0_0 true'), 'plugin recebeu setactive true (página atual)');

  section('3. toque na placa -> keydown/run/keyup -> toast e ícone novo');
  const before = (await raw(0)).toString('base64'), rev0 = d0.buttons[0].img;
  const pr = await req('POST', '/api/press/0', { headers: BOARD });
  check(pr.status === 200 && pr.json.ok === true && pr.json.toast === 'Executou 1' && pr.json.quiet === false, 'toque: resposta traz o toast do plugin', JSON.stringify(pr.json));
  check(await logHas('KEYDOWN 0_0') && await logHas('RUN 0_0 1 {}') && await logHas('KEYUP 0_0'), 'plugin recebeu keydown, run e keyup');
  await until('ícone/texto novos', async () => (await deck()).buttons[0].label.startsWith('n=1'));
  const d1 = await deck();
  check(d1.buttons[0].label === 'n=1 ~' && d1.buttons[0].img > rev0, 'texto novo do plugin; glifo ↻ (fora da fonte) trocado por "~"; contador de imagem avançou', JSON.stringify(d1.buttons[0]));
  check((await raw(0)).toString('base64') !== before, 'a imagem enviada à placa mudou');
  for (let k = 0; k < 2; k++) await req('POST', '/api/press/0', { headers: BOARD });
  check((await req('POST', '/api/press/0', { headers: BOARD })).json.toast === 'Executou 4', 'toques seguintes: o plugin mantém o estado (toast "Executou 4")');

  section('4. tela de configuração (property inspector) pelo WebSocket');
  const pi = piClient(A_COLOR, '0_0', actionid); check(await pi.opened, 'conexão com Origin da nossa página é aceita'); pi.hello(); await sleep(300);
  check(pi.got.some((m) => m.cmd === 'add' && m.actionid === actionid && m.param && typeof m.param === 'object') && pi.got.some((m) => m.cmd === 'paramfromapp'), 'tela recebe add e paramfromapp com as configurações salvas');
  pi.send({ cmd: 'sendToPlugin', uuid: A_COLOR, key: '0_0', actionid, payload: { type: 'getConfig' } }); await sleep(300);
  check(pi.got.some((m) => m.cmd === 'sendToPropertyInspector' && m.payload?.type === 'config'), 'sendToPlugin (tela -> plugin) e a resposta sendToPropertyInspector (plugin -> tela)');
  pi.send({ cmd: 'sendToPlugin', uuid: A_COLOR, key: '0_0', actionid, payload: { type: 'save', config: { color: '#22aa22' } } });
  await until('configuração salva em config.json', async () => (await cfg()).pages[0].buttons[0].action.settings?.color === '#22aa22');
  check((await cfg()).pages[0].buttons[0].action.settings.color === '#22aa22', 'setSettings do plugin é gravado em config.json (action.settings)');
  await until('ícone ficar verde', async () => { const [r, g] = px(await raw(0), 10, 20); return g > 130 && r < 90; });
  const [r2, g2] = px(await raw(0), 10, 20); check(g2 > 130 && r2 < 90, 'o plugin redesenhou o ícone com a nova cor (verde)', `RGB ${px(await raw(0), 10, 20).map(Math.round)}`);
  check(pi.got.some((m) => m.cmd === 'didReceiveSettings' && m.settings?.color === '#22aa22'), 'a tela também recebe didReceiveSettings');
  pi.send({ cmd: 'paramfromplugin', uuid: A_COLOR, key: '0_0', actionid, param: { color: '#2222cc', extra: 1 } });   // sendParamFromPlugin da tela
  await until('plugin receber paramfromapp', async () => logHas('PARAMFROMAPP {"color":"#2222cc","extra":1}'));
  check((await cfg()).pages[0].buttons[0].action.settings.extra === 1, 'paramfromplugin da tela: guardado e repassado ao plugin como paramfromapp');
  const stale = await req('PUT', '/api/button/1/0', { body: { label: '', action: { type: 'plugin', plugin: MAIN, action: A_COLOR, actionid, settings: { color: 'velho' } } } });
  check(stale.status === 200 && (await cfg()).pages[0].buttons[0].action.settings.color === '#2222cc', 'salvar o botão pela página NÃO sobrescreve as configurações do plugin (rascunho velho ignorado)');
  pi.ws.close();

  section('5. segurança do WebSocket');
  const evil = piClient(A_COLOR, '0_0', actionid, 'http://evil.example'); check(!(await evil.opened), 'Origin de outro site é recusado');
  const evil2 = piClient(A_COLOR, '0_0', actionid, 'http://localhost:9999'); check(!(await evil2.opened), 'Origin localhost em outra porta é recusado');
  const stranger = piClient(A_COLOR, '3_3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); await stranger.opened; stranger.hello(); await sleep(300);
  check(stranger.ws.readyState !== WebSocket.OPEN, 'tela de configuração de um botão que não existe: conexão encerrada');
  const logLen = (await pluginInfo()).log.length;
  const fakeMain = piClient(MAIN, '', ''); await fakeMain.opened; fakeMain.hello(); await sleep(400);   // outro processo tentando se passar pelo serviço principal do plugin
  check(fakeMain.ws.readyState !== WebSocket.OPEN, 'segunda conexão como "serviço principal" é recusada (a primeira vence)');
  check((await pluginInfo()).ready && (await req('POST', '/api/press/0', { headers: BOARD })).json.ok === true && !(await pluginInfo()).log.slice(logLen).some((l: string) => l.startsWith('ADD ')), 'o plugin verdadeiro continua conectado e funcionando (não foi derrubado nem reiniciado)');
  stranger.ws.close(); fakeMain.ws.close();

  section('6. configurações globais, hotkey, abrir URL');
  const pi2 = piClient(A_COLOR, '0_0', actionid); await pi2.opened; pi2.hello(); await sleep(250);
  pi2.send({ cmd: 'sendToPlugin', uuid: A_COLOR, key: '0_0', actionid, payload: { type: 'global' } });
  await until('configurações globais', async () => logHas('GLOBAL {"token":"g1"}'));
  const gf = path.join(DATA, 'plugin-settings', MAIN + '.json');
  check(fs.existsSync(gf) && (process.platform === 'win32' || (fs.statSync(gf).mode & 0o777) === 0o600) && JSON.parse(fs.readFileSync(gf, 'utf8')).token === 'g1', 'configurações globais gravadas em arquivo com permissão 600 (no Windows não há modo POSIX)');
  if (process.env.DEBUG_T) { console.log('--- log do plugin:', JSON.stringify((await pluginInfo()).log.slice(-14), null, 1)); console.log('--- log do servidor:', srvLog.slice(-12)); console.log('arquivo global existe?', fs.existsSync(gf), fs.existsSync(path.join(DATA, 'plugin-settings')) ? fs.readdirSync(path.join(DATA, 'plugin-settings')) : 'sem pasta'); }
  const mark = srvLog.length;
  pi2.send({ cmd: 'sendToPlugin', uuid: A_COLOR, key: '0_0', actionid, payload: { type: 'hotkey', keylist: '⌘⇧4' } });
  pi2.send({ cmd: 'sendToPlugin', uuid: A_COLOR, key: '0_0', actionid, payload: { type: 'hotkey', keylist: '^⌥M' } });
  pi2.send({ cmd: 'sendToPlugin', uuid: A_COLOR, key: '0_0', actionid, payload: { type: 'url', url: 'https://example.com/a', param: { x: '1' } } });
  pi2.send({ cmd: 'sendToPlugin', uuid: A_COLOR, key: '0_0', actionid, payload: { type: 'url', url: 'file:///etc/passwd' } });
  pi2.send({ cmd: 'sendToPlugin', uuid: A_COLOR, key: '0_0', actionid, payload: { type: 'url', url: './local.html', local: true } });
  await sleep(700); const out = srvLog.slice(mark).join('\n');
  check(out.includes('keystroke "4" using {command down, shift down}'), 'hotkey "⌘⇧4" do plugin vira Cmd+Shift+4');
  check(out.includes('keystroke "m" using {control down, option down}'), 'hotkey "^⌥M" do plugin vira Ctrl+Alt+M');
  check(out.includes("['open', '--', 'https://example.com/a?x=1']"), 'openUrl http(s) com parâmetros abre o navegador');
  check(!out.includes("['open', '--', 'file:") && !out.includes("'./local.html'") && (out.match(/openUrl só aceita http\(s\) externo/g) ?? []).length === 2, 'openUrl com file: e com caminho local é recusado (2 recusas, nenhum open)');
  pi2.ws.close();

  section('7. página ativa (setactive) e vários botões');
  const np = await req('POST', '/api/page', { body: { name: 'Outra' } }); const pid2 = np.json.id;
  await req('POST', `/api/current/${pid2}`); await until('setactive false', async () => logHas('ACTIVE 0_0 false'));
  check(await logHas('ACTIVE 0_0 false'), 'ao trocar de página o plugin recebe setactive false');
  const a2 = await req('POST', `/api/button/${pid2}/2/plugin`, { body: { plugin: MAIN, action: A_NOPI } }); check(a2.status === 200 && a2.json.pi === null, 'ação sem tela de configuração: atribui e não devolve URL de tela');
  await showText(pid2, 2, MAIN, A_NOPI, a2.json.actionid);
  await until('segundo botão', async () => (await deck()).buttons[2].label === 'FAKE\nOK');
  check((await deck()).buttons[2].label === 'FAKE\nOK', 'um segundo botão (outra página) também recebe ícone e texto do plugin');
  await req('POST', `/api/current/1`); await until('setactive true', async () => (await pluginInfo()).log.filter((l: string) => l === 'ACTIVE 0_0 true').length >= 2);
  check((await pluginInfo()).log.filter((l: string) => l === 'ACTIVE 0_0 true').length >= 2, 'ao voltar à página o plugin recebe setactive true de novo');
  const pv = await req('GET', '/api/preview/1/0.png'); check(pv.status === 200 && pv.body.subarray(1, 4).toString() === 'PNG', 'a prévia da página mostra o botão do plugin');

  section('8. o plugin cai e volta: o estado é restaurado');
  try {   // derruba o processo do plugin (pkill no Mac/Linux; PowerShell no Windows)
    if (process.platform === 'win32') execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*com.test.fake.ulanziPlugin*app.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`);
    else execSync(`pkill -f "${path.join(PLUGINS, 'com.test.fake.ulanziPlugin')}/plugin/app.js"`);
  } catch { /* sem alvo */ }
  await until('o plugin cair', async () => !(await pluginInfo()).ready, 6000);
  check(!(await pluginInfo()).ready, 'o servidor percebe que o plugin caiu');
  await until('o plugin voltar (toque funciona de novo)', async () => (await req('POST', '/api/press/0', { headers: BOARD })).json.ok === true, 15000);
  check((await pluginInfo()).ready, 'o host reiniciou o plugin sozinho e ele reconectou');
  await until('ícone com a cor salva', async () => { const [r, g, b] = px(await raw(0), 10, 20); return b > 150 && r < 90 && g < 90; });
  const [r3, g3, b3] = px(await raw(0), 10, 20);
  check(b3 > 150 && r3 < 90 && g3 < 90, 'depois de reiniciar, o plugin recebeu add com as configurações salvas (ícone azul #2222cc)', `RGB ${[r3, g3, b3].map(Math.round)}`);

  section('9. remover o botão: clear e o plugin deixa de rodar quando ninguém usa');
  await req('PUT', `/api/button/${pid2}/2`, { body: { action: null } });
  await until('clear do botão removido', async () => logHas('CLEAR 2_0'));
  check(await logHas('CLEAR 2_0'), 'plugin recebeu clear do botão removido');
  // arrastar o botão do plugin para outro lugar da grade: o plugin é avisado da nova posição (clear da antiga, add da nova) e o botão continua funcionando
  const lenSw = (await pluginInfo()).log.length;
  check((await req('POST', '/api/button/1/0/swap-dummy')).status !== 500, 'rota inexistente não derruba o servidor');
  const swp = await req('POST', '/api/swap/1/0/2'); check(swp.status === 200, 'mover o botão do plugin (0 -> 2)');
  await until('plugin recebe a nova posição', async () => (await pluginInfo()).log.slice(lenSw).some((l: string) => l.startsWith('ADD 2_0')));
  const lg = (await pluginInfo()).log.slice(lenSw);
  check(lg.some((l: string) => l.startsWith('CLEAR 0_0')) && lg.some((l: string) => l.startsWith('ADD 2_0')), 'plugin recebeu clear da posição antiga e add da nova', JSON.stringify(lg));
  check((await req('POST', '/api/press/2', { headers: BOARD })).json.ok === true, 'o botão movido continua respondendo ao toque (novo índice 2)');
  await req('POST', '/api/swap/1/2/0'); await until('plugin volta à posição original', async () => (await pluginInfo()).log.slice(lenSw).some((l: string) => l.startsWith('ADD 0_0')));
  if (process.env.DEBUG_T) { console.log('--- após remover o botão, log do plugin:', JSON.stringify((await pluginInfo()).log.slice(-10), null, 1)); console.log('--- servidor:', srvLog.slice(-8)); }
  check((await req('GET', '/api/plugins')).json.plugins.find((p: any) => p.uuid === MAIN).running === true, 'enquanto outro botão usa o plugin, ele continua rodando');
  await req('PUT', '/api/button/1/0', { body: { action: null } }); await until('plugin parar', async () => !(await pluginInfo()).running);
  check(!(await pluginInfo()).running, 'sem nenhum botão usando o plugin, o processo é encerrado');
  const dnone = await deck(); check(dnone.buttons[0].label === '', 'o botão volta a ficar sem texto (sem título, sem plugin)', JSON.stringify(dnone.buttons[0]));

  section('10. importar do Ulanzi Studio');
  writeFakePlugin(path.join(ULANZI, 'com.test.imported.ulanziPlugin'), 'com.test.ulanzistudio.imported', 'Importado');
  fs.mkdirSync(path.join(ULANZI, 'com.test.imported.ulanziPlugin', '.git'), { recursive: true });
  const av = (await req('GET', '/api/plugins/available')).json;
  check(av.length === 1 && av[0].dir === 'com.test.imported.ulanziPlugin' && av[0].sensitive.includes('key.pem') && av[0].sensitive.includes('config.json') && av[0].supported, 'lista o importável e avisa dos arquivos sensíveis (key.pem, config.json)', JSON.stringify(av));
  for (const badDir of ['../../etc', 'x.ulanziPlugin/..', 'com.test.fake.ulanziPlugin', 'naoexiste.ulanziPlugin']) { const r = await req('POST', '/api/plugins/import', { body: { dir: badDir } }); check(r.status === 400, `importar "${badDir}" é recusado`, r.json?.erro); }
  const imp = await req('POST', '/api/plugins/import', { body: { dir: 'com.test.imported.ulanziPlugin' } });
  check(imp.status === 200 && fs.existsSync(path.join(PLUGINS, 'com.test.imported.ulanziPlugin', 'manifest.json')) && !fs.existsSync(path.join(PLUGINS, 'com.test.imported.ulanziPlugin', '.git')), 'importado (cópia, sem .git)');
  check((await req('GET', '/api/plugins')).json.plugins.some((p: any) => p.name === 'Importado') && (await req('GET', '/api/plugins/available')).json.length === 0, 'aparece nos plugins e some da lista de importáveis');

  section('10a. importar de QUALQUER pasta ou .zip (fora do Ulanzi Studio)');
  { const imp2 = (pth: string) => req('POST', '/api/plugins/import', { body: { path: pth } });
    const EXT = path.join(TMP, 'externo'); fs.mkdirSync(EXT, { recursive: true });
    const mkPlugin = (dirName: string, uuid: string, name: string) => { const root = path.join(EXT, dirName); writeFakePlugin(root, uuid, name); fs.rmSync(path.join(root, 'config.json'), { force: true }); fs.rmSync(path.join(root, 'key.pem'), { force: true }); return root; };
    check((await imp2('relativo/plugin')).status === 400, 'caminho relativo: recusado');
    check((await imp2(path.join(EXT, 'nao-existe'))).status === 400, 'caminho que não existe: recusado');
    fs.mkdirSync(path.join(EXT, 'vazia')); const semMan = await imp2(path.join(EXT, 'vazia')); check(semMan.status === 400 && /manifest/.test(semMan.json?.erro), 'pasta sem manifest.json: recusada com mensagem clara', semMan.json?.erro);
    const html = path.join(EXT, 'so-html'); writeFakePlugin(html, 'com.test.ulanzistudio.html2', 'Html2', 'plugin/app.html'); const rh = await imp2(html); check(rh.status === 400 && /JavaScript/.test(rh.json?.erro), 'plugin com serviço em HTML: recusado', rh.json?.erro);
    const evil = mkPlugin('evil', 'com.test.ulanzistudio.evil', 'Evil'); const mf = JSON.parse(fs.readFileSync(path.join(evil, 'manifest.json'), 'utf8')); mf.CodePath = '../fora.js'; fs.writeFileSync(path.join(evil, 'manifest.json'), JSON.stringify(mf));
    check((await imp2(evil)).status === 400, 'CodePath que sai da pasta do plugin: recusado');
    const ok1 = mkPlugin('meu-plugin', 'com.test.ulanzistudio.meu', 'Meu Plugin'); fs.symlinkSync('/etc', path.join(ok1, 'atalho-para-fora'));
    const r1 = await imp2(ok1); check(r1.status === 200 && r1.json.name === 'Meu Plugin' && r1.json.dir === 'meu-plugin.ulanziPlugin', 'pasta com nome livre: importada como meu-plugin.ulanziPlugin', JSON.stringify(r1.json));
    check(fs.existsSync(path.join(PLUGINS, 'meu-plugin.ulanziPlugin', 'manifest.json')) && !fs.existsSync(path.join(PLUGINS, 'meu-plugin.ulanziPlugin', 'atalho-para-fora')), 'copiou o plugin e NÃO copiou o atalho que aponta para fora');
    await until('o plugin importado aparecer na lista', async () => (await req('GET', '/api/plugins')).json.plugins.some((p: any) => p.name === 'Meu Plugin' && p.supported));
    check((await imp2(ok1)).status === 400, 'importar de novo: recusado (já existe)');
    const ok2 = mkPlugin('zipado', 'com.test.ulanzistudio.zip', 'Plugin Zip'); const zip = path.join(EXT, 'zipado.zip');
    writeZip(zip, path.join(EXT, 'zipado'), 'zipado');   // zip em JS puro (sem depender do comando zip, que não existe no Windows)
    const r2 = await imp2(zip); check(r2.status === 200 && r2.json.name === 'Plugin Zip', 'arquivo .zip (com uma pasta dentro): importado', JSON.stringify(r2.json));
    check((await imp2(path.join(EXT, 'zipado', 'manifest.json'))).status === 400, 'arquivo que não é .zip: recusado'); void ok2; }

  section('10c. apagar plugin: some a pasta e todo botão que o usa é limpo');
  { const MEU = 'com.test.ulanzistudio.meu', MEU_ACT = MEU + '.color', MEU_DIR = path.join(PLUGINS, 'meu-plugin.ulanziPlugin');
    const a1 = await req('POST', '/api/button/1/4/plugin', { body: { plugin: MEU, action: MEU_ACT } }), a2 = await req('POST', '/api/button/1/5/plugin', { body: { plugin: MEU, action: MEU_ACT } });
    await req('PUT', '/api/button/1/5', { body: { label: 'Meu botão', action: { type: 'plugin', plugin: MEU, action: MEU_ACT, actionid: a2.json.actionid } } });
    check(a1.status === 200 && a2.status === 200, 'dois botões usam o plugin "Meu Plugin"');
    check((await req('GET', '/api/plugins')).json.plugins.find((p: any) => p.uuid === MEU)?.uses === 2, 'a lista de plugins informa quantos botões usam (uses = 2)');
    const keep = JSON.stringify((await cfg()).pages[0].buttons[0]);   // um botão de OUTRO plugin/ação deve ficar intacto
    check((await req('DELETE', '/api/plugins/' + encodeURIComponent('nao.existe'))).status === 400, 'apagar plugin inexistente: recusado');
    const del = await req('DELETE', '/api/plugins/' + encodeURIComponent(MEU));
    check(del.status === 200 && del.json.cleared === 2 && del.json.name === 'Meu Plugin', 'apagar: 2 botões limpos', JSON.stringify(del.json));
    const c2 = await cfg(), bs = c2.pages[0].buttons;
    check([4, 5].every((i) => !bs[i].action && bs[i].label === '' && !bs[i].image), 'os dois botões voltaram a vazios');
    check(!fs.existsSync(MEU_DIR) && !(await req('GET', '/api/plugins')).json.plugins.some((p: any) => p.uuid === MEU), 'a pasta do plugin foi apagada e ele sumiu da lista');
    check(JSON.stringify(bs[0]) === keep, 'botões de outros plugins/ações ficam intactos');
    check((await req('DELETE', '/api/plugins/' + encodeURIComponent(MEU))).status === 400, 'apagar de novo: recusado'); }

  section('10b. GIF animado de plugin (estado tipo 3) vira animação do botão');
  const gifSlot = 3, ga = await req('POST', `/api/button/1/${gifSlot}/plugin`, { body: { plugin: MAIN, action: A_GIF } });
  check(ga.status === 200, 'atribui a ação que manda um GIF de 2 quadros');
  await until('o plugin mandar o GIF', async () => { const d = (await req('GET', '/api/deck?cap=tiles,anim&fill=1000000', { headers: BOARD })).json; return d.buttons.find((b: any) => b.i === gifSlot)?.anim?.n === 2; }, 8000);
  const dg = (await req('GET', '/api/deck?cap=tiles,anim&fill=1000000', { headers: BOARD })).json, tg = dg.buttons.find((b: any) => b.i === gifSlot);
  check(tg?.anim?.n === 2 && Number.isInteger(tg.anim.rev), 'o botão do plugin traz anim {n:2, rev}', JSON.stringify(tg?.anim));
  const ab = await req('GET', `/api/anim/${gifSlot}.bin`, { headers: BOARD }), bw = tg.w, bh = tg.h;
  check(ab.status === 200 && ab.body.length === 4 + 4 + 2 * bw * bh * 2, 'quadros no tamanho do botão', `${ab.body?.length}`);
  const px0 = ab.body.readUInt16LE(8 + (Math.floor(bw / 2) + 5 * bw) * 2), px1 = ab.body.readUInt16LE(8 + bw * bh * 2 + (Math.floor(bw / 2) + 5 * bw) * 2);   // pixel no topo/centro (ícone quadrado "contain")
  check((px0 >> 11) > 28 && ((px1 >> 5) & 63) > 58, 'cores dos quadros do GIF do plugin: vermelho e verde', `${px0.toString(16)} ${px1.toString(16)}`);
  await req('PUT', `/api/button/1/${gifSlot}`, { body: { label: '', action: null } });

  section('11. reiniciar o servidor: atribuições voltam sozinhas');
  const strd = (await req('GET', '/api/settings')).json.stride as number, slotB5 = strd + 1;   // linha 1, coluna 1 (posição 5 da placa)
  const ra = await req('POST', `/api/button/1/${slotB5}/plugin`, { body: { plugin: MAIN, action: A_COLOR } }); check(ra.status === 200, 'atribui um botão antes de reiniciar'); await showText(1, slotB5, MAIN, A_COLOR, ra.json.actionid);
  srv.kill('SIGTERM'); await sleep(800); await startServer();
  await until('botão voltar após reinício', async () => (await deck()).buttons[5].label === 'FAKE\nOK');
  check((await deck()).buttons[5].label === 'FAKE\nOK', 'depois de reiniciar o servidor, o plugin é iniciado e o botão volta com ícone e texto');

  console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); fails.forEach((f) => console.log(' -', f));
}
main().catch((e) => { console.error('ERRO NO TESTE:', e); fails.push('erro: ' + e); }).finally(() => {
  srv?.kill('SIGTERM'); try { execSync(`pkill -f "${TMP}"`); } catch { /* nada a matar */ }
  setTimeout(() => { fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails.length ? 1 : 0); }, 600);
});
