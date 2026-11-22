// Stream Deck (app de barra de menu). O Electron é só a casca: o servidor é o mesmo código Node de ../node, compilado em ./server e rodando como
// PROCESSO FILHO (o próprio executável do Electron em modo Node: ELECTRON_RUN_AS_NODE). A placa depende do servidor, não da janela:
// fechar a janela destrói o Chromium (devolve a memória) e o servidor segue rodando; o ícone na barra de menu abre a janela de novo.
const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage, session } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');

const PORT = Number(process.env.DECK_PORT || 8765);
const ORIGIN = `http://localhost:${PORT}`;
const SERVER_MAIN = path.join(__dirname, 'server', 'src', 'main.js');
const REPO = path.resolve(__dirname, '..');   // raiz do repositório (só em desenvolvimento)

// ---------- pastas de dados ----------
// App instalado: tudo na pasta de dados do app (macOS: ~/Library/Application Support/Stream Deck ESP). Em desenvolvimento (electron .): usa as pastas do repositório (data/ e node/plugins/).
// Qualquer DECK_* de fora (testes) vence.
function dirs() {
  if (app.isPackaged) {
    const base = app.getPath('userData');
    return { data: path.join(base, 'dados'), cache: path.join(base, 'cache'), plugins: path.join(base, 'plugins'), logs: app.getPath('logs') };
  }
  return { data: path.join(REPO, 'data'), cache: path.join(REPO, 'data', 'cache'), plugins: path.join(REPO, 'node', 'plugins'), logs: path.join(os.tmpdir(), 'streamdeck-app-logs') };
}
const D = dirs();
for (const [k, v] of [['DECK_DATA', D.data], ['DECK_CACHE', D.cache], ['DECK_PLUGINS_DIR', D.plugins]]) if (!process.env[k]) process.env[k] = v;
const DATA = path.resolve(process.env.DECK_DATA);

// ---------- idioma (menu e diálogos do app; a página tem o dela, em /api/i18n) ----------
// O texto em português é a chave. A escolha é a mesma da página (settings.json -> lang); sem escolha, segue o idioma do sistema.
const EN = {
  'Não consegui importar tudo': 'Could not import everything', 'O servidor parou': 'The server stopped',
  'O servidor do Stream Deck caiu várias vezes seguidas.\nVeja o log em:\n{log}': 'The Stream Deck server crashed several times in a row.\nSee the log at:\n{log}',
  'Usar o que está rodando': 'Use the running one', 'Sair': 'Quit', 'Já existe um servidor do Stream Deck na porta {port}.': 'A Stream Deck server already exists on port {port}.',
  'Provavelmente é o node/iniciar.sh do projeto. Posso abrir a janela dele, ou você fecha aquele e abre o app de novo.': 'It is probably the project\'s node/iniciar.sh. I can open its window, or you can close that one and open the app again.',
  'O servidor não iniciou': 'The server did not start', 'Veja o log em:\n{log}': 'See the log at:\n{log}',
  'Iniciando…': 'Starting…', 'Servidor parado': 'Server stopped', 'Placa conectada ({ip})': 'Board connected ({ip})', 'Placa aguardando pareamento': 'Board waiting to pair', 'Aguardando a placa': 'Waiting for the board',
  'Abrir Stream Deck ESP': 'Open Stream Deck ESP', 'Parear a placa (90 s)': 'Pair the board (90 s)', 'Abrir ao ligar o Mac': 'Open when the Mac starts', 'Abrir ao iniciar o sistema': 'Open at system startup',
  'Mostrar a pasta de dados': 'Show the data folder', 'Mostrar o log do servidor': 'Show the server log', 'Sair do Stream Deck ESP': 'Quit Stream Deck ESP',
};
function lang() {
  try { const l = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).lang; if (l === 'pt' || l === 'en') return l; } catch { /* sem escolha ainda */ }
  return /^pt/i.test(app.getLocale()) ? 'pt' : 'en';
}
const L = (pt, vars) => { let o = lang() === 'en' ? (EN[pt] ?? pt) : pt; for (const k in vars || {}) o = o.replace(`{${k}}`, vars[k]); return o; };

// ---------- log do servidor (arquivo com rotação simples) ----------
fs.mkdirSync(D.logs, { recursive: true });
const LOG = path.join(D.logs, 'servidor.log');
try { if (fs.statSync(LOG).size > 2_000_000) fs.renameSync(LOG, LOG + '.1'); } catch { /* ainda não existe */ }
const logStream = fs.createWriteStream(LOG, { flags: 'a' });
const log = (s) => logStream.write(`[${new Date().toISOString()}] ${s}\n`);

// ---------- anúncio mDNS (a placa acha o servidor por _streamdeck._tcp) ----------
// macOS: feito aqui pelo `dns-sd`. Windows e Linux: o servidor Node anuncia sozinho (bonjour-service), então este trecho não faz nada.
// Registrado pelo `dns-sd` do macOS (que fala com o mDNSResponder do sistema). Mandar o multicast direto de dentro do app exige a permissão
// "Rede local" e falhava com EHOSTUNREACH; registrando pelo serviço do sistema o app não precisa dela. Fica rodando enquanto o app roda.
let adv = null;
function startAdvertise() {
  if (process.platform !== 'darwin' || process.env.DECK_NOMDNS || quitting) return;   // Windows/Linux: o próprio servidor anuncia (bonjour-service, em JS)
  const name = `Stream Deck (${os.hostname().split('.')[0]})`;
  adv = spawn('/usr/bin/dns-sd', ['-R', name, '_streamdeck._tcp', 'local', String(PORT), 'v=1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  log(`[mdns] registrando "${name}" _streamdeck._tcp porta ${PORT} (dns-sd pid ${adv.pid})`);
  adv.stdout.on('data', (d) => log('[mdns] ' + String(d).trim().split('\n').slice(-1)[0]));
  adv.on('error', (e) => log('[mdns] erro: ' + e));
  adv.on('exit', (code) => { adv = null; if (!quitting) { log(`[mdns] dns-sd saiu (${code}); registrando de novo em 5 s`); setTimeout(startAdvertise, 5000); } });
}
function stopAdvertise() { try { adv && adv.kill('SIGTERM'); } catch { /* já saiu */ } }

// ---------- servidor ----------
let child = null, quitting = false, restarts = [], usingExternal = false;
const get = (p, ms = 1500) => new Promise((resolve) => {
  const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: ms }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
  r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
});
const post = (p) => new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', timeout: 2000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); r.on('error', () => resolve(0)); r.end(); });
const waitServer = async (ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await get('/api/status'); if (r && r.status === 200) return true; await new Promise((s) => setTimeout(s, 250)); } return false; };

function startServer() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DECK_PARENT_PID: String(process.pid), DECK_USB: '1', ...(process.platform === 'darwin' ? { DECK_NOMDNS: '1' } : {}) };   // o anúncio mDNS é feito por este processo (startAdvertise)   // o filho (e os plugins que ele inicia) rodam o executável do Electron como Node
  child = spawn(process.execPath, [SERVER_MAIN], { env, cwd: path.join(__dirname, 'server'), stdio: ['ignore', 'pipe', 'pipe'] });
  log(`servidor iniciado (pid ${child.pid})`);
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => logStream.write(d));
  child.on('exit', (code, sig) => {
    log(`servidor saiu (código ${code}, sinal ${sig})`); child = null;
    if (quitting) return;
    const now = Date.now(); restarts = restarts.filter((t) => now - t < 60_000); restarts.push(now);
    if (restarts.length > 4) { dialog.showErrorBox(L('O servidor parou'), L('O servidor do Stream Deck caiu várias vezes seguidas.\nVeja o log em:\n{log}', { log: LOG })); return; }
    setTimeout(startServer, 1000 * restarts.length);   // volta sozinho, com espera crescente
  });
}
function stopServer() { return new Promise((resolve) => { if (!child) return resolve(); const c = child; const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* já saiu */ } resolve(); }, 3000); c.once('exit', () => { clearTimeout(t); resolve(); }); try { c.kill('SIGTERM'); } catch { resolve(); } }); }

async function ensureServer() {
  const existing = await get('/api/status');
  if (existing && existing.status === 200) {   // porta já ocupada por um servidor do Stream Deck (ex.: node/iniciar.sh)
    const r = await dialog.showMessageBox({ type: 'question', buttons: [L('Usar o que está rodando'), L('Sair')], defaultId: 0, cancelId: 1, message: L('Já existe um servidor do Stream Deck na porta {port}.', { port: PORT }), detail: L('Provavelmente é o node/iniciar.sh do projeto. Posso abrir a janela dele, ou você fecha aquele e abre o app de novo.') });
    if (r.response !== 0) return false;
    usingExternal = true; return true;
  }
  startServer();
  if (!(await waitServer())) { dialog.showErrorBox(L('O servidor não iniciou'), L('Veja o log em:\n{log}', { log: LOG })); return false; }
  return true;
}

// ---------- janela (criada sob demanda e destruída ao fechar) ----------
let win = null;
function openWindow() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 720, minHeight: 520, title: 'Stream Deck ESP', backgroundColor: '#1b1c20', show: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; if (process.platform === 'darwin' && app.dock) app.dock.hide(); });   // sem janela: só o ícone da barra de menu
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.loadURL(ORIGIN + '/');
  if (process.platform === 'darwin' && app.dock) app.dock.show();
}

// ---------- ícone da barra de menu ----------
let tray = null, shown = '', status = { connected: false, key: 'Iniciando…' };
function trayIcon() {
  if (process.platform === 'darwin') {   // modelo (só o alfa importa): o macOS pinta conforme o tema
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png'));
    if (!img.isEmpty()) { img.setTemplateImage(true); return img; }
    return nativeImage.createEmpty();
  }
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));   // Windows/Linux: o ícone colorido do app (o modelo preto sumiria numa barra escura)
  return img.isEmpty() ? img : img.resize({ width: 20, height: 20 });
}
const statusText = () => L(status.key, status.vars);
function buildMenu() {
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: L('Abrir Stream Deck ESP'), click: openWindow },
    { label: statusText(), enabled: false },
    { type: 'separator' },
    { label: L('Parear a placa (90 s)'), click: async () => { await post('/api/pairing/start'); openWindow(); } },
    { label: process.platform === 'darwin' ? L('Abrir ao ligar o Mac') : L('Abrir ao iniciar o sistema'), type: 'checkbox', checked: login, enabled: app.isPackaged && process.platform !== 'linux', click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked, openAsHidden: true }) },
    { type: 'separator' },
    { label: L('Mostrar a pasta de dados'), click: () => shell.openPath(DATA) },
    { label: L('Mostrar o log do servidor'), click: () => shell.showItemInFolder(LOG) },
    { type: 'separator' },
    { label: L('Sair do Stream Deck ESP'), accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ]);
}
async function refreshStatus() {
  const r = await get('/api/status', 1200);
  const s = r && r.json;
  status = !s ? { connected: false, key: 'Servidor parado' } : s.connected ? { connected: true, key: 'Placa conectada ({ip})', vars: { ip: s.board_ip } } : s.unpaired_ip ? { connected: false, key: 'Placa aguardando pareamento' } : { connected: false, key: 'Aguardando a placa' };
  const now = lang() + '|' + statusText();   // o idioma entra na comparação: trocar de idioma refaz o menu
  if (tray && now !== shown) { shown = now; tray.setToolTip(`Stream Deck ESP: ${statusText()}`); tray.setContextMenu(buildMenu()); }   // só refaz o menu se mudou (um menu aberto não fecha)
}

// ---------- ciclo de vida ----------
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.quit());   // encerrar pelo terminal também desliga o servidor
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => openWindow());
  app.on('activate', () => openWindow());                      // clique no ícone do Dock
  app.on('window-all-closed', () => { /* continua na barra de menu */ });
  app.on('before-quit', (e) => { if (quitting) return; quitting = true; stopAdvertise(); if (child) { e.preventDefault(); stopServer().then(() => app.quit()); } });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));   // a página não precisa de câmera, localização etc.
    tray = new Tray(trayIcon()); tray.setToolTip('Stream Deck ESP'); tray.setContextMenu(buildMenu());
    tray.on('click', () => { /* o menu abre sozinho */ });
    if (!(await ensureServer())) { app.quit(); return; }
    if (!usingExternal) startAdvertise();
    await refreshStatus(); setInterval(refreshStatus, 5000);
    const hidden = app.getLoginItemSettings().wasOpenedAtLogin;   // aberto no login: fica só na barra de menu
    if (hidden && app.isPackaged) { if (app.dock) app.dock.hide(); } else openWindow();
    log(`app pronto: ${ORIGIN} (${usingExternal ? 'servidor externo' : 'servidor próprio'})`);
  });
}
