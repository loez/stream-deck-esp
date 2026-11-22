// Host de plugins: inicia o serviço principal (Node) de cada plugin em uso, fala com ele (e com as telas de configuração) por WebSocket e transforma o que ele manda em ícone/nome do botão na placa.
//   - descobre plugins em PLUGINS_DIR: `*.deckplugin` (formato nosso: plugin.json) e `*.ulanziPlugin` (formato do Ulanzi Studio: manifest.json, só por compatibilidade);
//   - WebSocket em 127.0.0.1:PLUGIN_PORT. O host só conhece eventos normalizados (src/plugin-protocol.ts): a língua nossa (v2, docs/PROTOCOLO-PLUGIN.md) e a legada do Ulanzi viram a mesma coisa;
//   - a conexão escolhe a língua na primeira mensagem: `hello` (v2) ou `connected` (legado).
// Botão = atribuição de uma ação a uma posição; identificado pelo `id` (id da atribuição, guardado em config.json junto com as configurações). key = "coluna_linha".
import { getLang } from './i18n.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { PLUGINS_DIR, PLUGIN_PORT, ULANZI_DIR, PORT, DATA, UPLOADS } from './env.ts';
import type { Store, Button } from './config.ts';
import { STRIDE } from './settings.ts';
import { hooks } from './hooks.ts';
import { platform } from './platform/index.ts';
import type { Result } from './hooks.ts';
import { decodeImageBuffer, invalidateRaw } from './render.ts';
import { isGif, decodeGif } from './anim.ts';
import type { GifFrames } from './anim.ts';
import type { Raster } from './resample.ts';
import { ACTIONS } from './actions.ts';
import { decodeDeck, encodeDeck, decodeUlanzi, encodeUlanzi } from './plugin-protocol.ts';
import type { In, Out, Proto, BtnRef } from './plugin-protocol.ts';

type MAction = { id: string; name: string; icon?: string; tooltip?: string; ui?: string; states: { name?: string; image?: string }[] };
type Manifest = { id: string; name: string; version?: string; author?: string; description?: string; icon?: string; main: string; actions: MAction[]; fmt: 'deck' | 'ulanzi'; jsOk: boolean; locales?: Record<string, Record<string, string>> };
type Plugin = { dir: string; root: string; m: Manifest; supported: boolean; why: string; proc?: ChildProcess; sock?: WebSocket; wantRun: boolean; restarts: number[]; failed: boolean; told: Set<string>; activeTold: Map<string, boolean>; log: string[] };
type Assign = { ctx: string; pid: number; slot: number; plugin: string; action: string; actionid: string; key: string; settings: Record<string, any>; active: boolean };
type Meta = { role: 'main' | 'pi'; proto: Proto; plugin?: Plugin; ctx?: string };
type Icon = { raster: Raster | null; text: string; ver: number; sig: string; anim?: GifFrames };

/** Lê o manifesto de uma pasta de plugin: plugin.json (nosso) ou manifest.json (Ulanzi Studio, convertido). Lança com a razão se não servir. */
export function readManifest(root: string): Manifest {
  const own = path.join(root, 'plugin.json'), legacy = path.join(root, 'manifest.json');
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new Error(`${path.basename(f)} inválido (não é JSON)`); } };
  if (fs.existsSync(own)) {
    const j = read(own);
    if (!j.id || !j.name || !j.main || !Array.isArray(j.actions) || !j.actions.length) throw new Error('plugin.json precisa de id, name, main e actions');
    return { id: String(j.id), name: String(j.name), version: j.version, author: j.author, description: j.description, icon: j.icon, main: String(j.main), fmt: 'deck', jsOk: /\.m?js$/.test(String(j.main)), locales: j.locales && typeof j.locales === 'object' ? j.locales : undefined,
      actions: j.actions.map((a: any) => ({ id: String(a.id), name: String(a.name ?? a.id), icon: a.icon, tooltip: a.tooltip, ui: a.ui, states: Array.isArray(a.states) ? a.states : [] })) };
  }
  if (fs.existsSync(legacy)) {   // formato do Ulanzi Studio
    const j = read(legacy);
    if (!j.Name || !j.UUID || !Array.isArray(j.Actions) || !j.Actions.length) throw new Error('manifest.json precisa de Name, UUID, CodePath e Actions');
    const code = String(j.CodePath || '');
    return { id: String(j.UUID), name: String(j.Name), version: j.Version, author: j.Author, description: j.Description, icon: j.Icon, main: code, fmt: 'ulanzi', jsOk: j.Type === 'JavaScript' && /\.m?js$/.test(code),
      actions: j.Actions.map((a: any) => ({ id: String(a.UUID), name: String(a.Name ?? a.UUID), icon: a.Icon, tooltip: a.Tooltip, ui: a.PropertyInspectorPath, states: Array.isArray(a.States) ? a.States.map((x: any) => ({ name: x.Name, image: x.Image })) : [] })) };
  }
  throw new Error('não achei um plugin aí: faltou o plugin.json (ou o manifest.json do Ulanzi Studio)');
}
const PLUGIN_DIR_RE = /\.(deckplugin|ulanziPlugin)$/;

const APP_VERSION = '3.4.4';   // argumentos extras que plugins do Ulanzi esperam (versão e idioma)
const pluginLang = () => (getLang() === 'en' ? 'en' : 'pt-BR');   // idioma do app, entregue ao plugin ao iniciar (argv[4]; o SDK expõe plugin.language)
const keyOf = (slot: number) => `${slot % STRIDE}_${Math.floor(slot / STRIDE)}`;   // posição "coluna_linha"
const SENSITIVE = /\.pem$|^config\.json$|^devices\.json$|^channels\.json$|\.env$/i;
const STATIC_EXT = /\.(html|js|mjs|css|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i;
const STATIC_DENY = /^(config|devices|channels|buttons|package|package-lock)\.json$/i;   // arquivos de dados/segredos do plugin: nunca servidos pela web
const CTYPES: Record<string, string> = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf' };

/** Ajustes mínimos na CÓPIA local de plugins de terceiros que não convivem com o Ulanzi Studio aberto (idempotentes; valem também depois de importar de novo).
 *  Spotify: o serviço do plugin escuta numa porta FIXA (30901) que o Ulanzi Studio já usa quando o plugin dele está ativo: o nosso caía com EADDRINUSE e ficava "com falha".
 *  Aqui ele passa para a 30902 (DECK_SPOTIFY_PORT muda). O endereço de retorno do login (redirect URI) acompanha a porta: é preciso cadastrá-lo também no painel do Spotify. */
const PATCHES: Record<string, { file: string; from: string; to: () => string; why: string }[]> = {
  'com.ulanzi.ulanzideck.spotify': [{ file: 'app/index.js', from: '.listen(30901,', to: () => `.listen(${Number(process.env.DECK_SPOTIFY_PORT) || 30902},`, why: 'porta 30901 é do Ulanzi Studio' }],
};
function applyPatches(uuid: string, root: string): void {
  for (const pt of PATCHES[uuid] ?? []) {
    const f = path.join(root, pt.file);
    try {
      const src = fs.readFileSync(f, 'utf8');
      if (!src.includes(pt.from)) continue;   // já ajustado (ou outra versão do plugin): não mexe
      fs.writeFileSync(f, src.split(pt.from).join(pt.to()));
      console.log(`[plugins] ${uuid}: ${pt.why}; usando a porta ${pt.to().replace(/\D/g, '')}`);
    } catch { /* arquivo ausente: ignora */ }
  }
}

/** O macOS bloqueia o acesso à rede local do app (Ajustes > Privacidade > Rede Local): o plugin recebe EHOSTUNREACH repetido ao falar com um aparelho da LAN (IP privado), o que não acontece no terminal. */
const PRIVATE_IP = /(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/;
export const lanBlocked = (log: string[]): boolean => log.filter((l) => l.includes('EHOSTUNREACH') && PRIVATE_IP.test(l)).length >= 3;
export type PluginInfo = { uuid: string; name: string; version: string; author: string; description: string; dir: string; supported: boolean; why: string; running: boolean; ready: boolean; failed: boolean; icon: string; lanBlocked: boolean; lanProbe: string; uses: number; dev: { linked: string; watching: boolean; reloadedAt: number; reloadWhy: string; error: string };
  actions: { uuid: string; name: string; tooltip: string; hasPI: boolean; icon: string }[]; log: string[] };
export type Importable = { dir: string; name: string; version: string; supported: boolean; why: string; sensitive: string[] };

export class PluginHost {
  readonly store: Store;
  plugins = new Map<string, Plugin>();
  private wss?: WebSocketServer;
  private want = new Map<string, Assign>();
  private icons = new Map<string, Icon>();                       // por actionid
  private pis = new Map<string, Set<WebSocket>>();               // telas de configuração abertas, por contexto
  private meta = new WeakMap<WebSocket, Meta>();
  private toastWait?: { ctx: string; resolve: (t: string) => void };
  private placeholders = new Map<string, Raster | null>();
  private stopping = false;
  private syncTimer?: NodeJS.Timeout;
  private verCounter = 0;

  constructor(store: Store) { this.store = store; }

  // ================= ciclo de vida =================
  /** Escaneia os plugins e abre o WebSocket. Retorna false (sem derrubar o servidor) se a porta estiver ocupada. */
  async start(): Promise<boolean> {
    this.scan();
    const allowed = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
    const ok = await new Promise<boolean>((resolve) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1', port: PLUGIN_PORT,
        // Processos de plugin (Node) não enviam Origin. Páginas web enviam: só aceitamos a nossa própria página (a tela de configuração do plugin roda nela, num iframe).
        verifyClient: (info: { origin?: string }) => !info.origin || allowed.has(info.origin),
      });
      wss.once('listening', () => { this.wss = wss; resolve(true); });
      wss.once('error', (e: Error) => { console.log(`[plugins] não foi possível abrir 127.0.0.1:${PLUGIN_PORT} (${e.message}): plugins desativados`); resolve(false); });
    });
    if (!ok) return false;
    this.wss!.on('connection', (ws) => {
      ws.on('message', (raw) => { try { this.onMessage(ws, JSON.parse(raw.toString())); } catch (e) { console.log('[plugins] mensagem inválida:', e instanceof Error ? e.message : e); } });
      ws.on('close', () => this.onClose(ws));
      ws.on('error', () => {});
    });
    hooks.pluginLabel = (b) => this.labelFor(b);
    hooks.pluginAnim = (b) => { const ic = this.icons.get(String(b.action?.actionid)); return ic?.anim ? { ver: ic.ver, gif: ic.anim } : undefined; };
    hooks.pluginText = (b) => this.icons.get(String(b.action?.actionid))?.text || undefined;
    hooks.pluginIcon = (b) => this.iconFor(b);
    hooks.pluginVersion = (b) => this.icons.get(String(b.action?.actionid))?.ver ?? 0;
    hooks.pluginPress = (pid, i) => this.press(pid, i);
    hooks.pluginValidate = (a) => this.validate(a);
    this.store.onSave.push(() => this.queueSync());
    this.loadDev(); this.rewatch();
    this.queueSync();
    console.log(`[plugins] host em ws://127.0.0.1:${PLUGIN_PORT}; ${this.plugins.size} plugin(s) em ${PLUGINS_DIR} (${[...this.plugins.values()].filter((p) => p.supported).length} suportado(s))`);
    return true;
  }

  stop(): void {
    this.stopping = true; clearTimeout(this.syncTimer); for (const k of [...this.watchers.keys()]) this.unwatch(k);
    for (const p of this.plugins.values()) { p.wantRun = false; p.proc?.kill('SIGTERM'); }
    this.wss?.close();
  }

  /** Lê os manifestos de PLUGINS_DIR. */
  scan(): void {
    const old = this.plugins; this.plugins = new Map();
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(PLUGINS_DIR).filter((d) => PLUGIN_DIR_RE.test(d)).sort(); } catch { /* pasta ainda não existe */ }
    for (const dir of dirs) {
      const root = path.join(PLUGINS_DIR, dir);
      try {
        const m = readManifest(root);
        let supported = true, why = '';
        if (/\.html?$/.test(m.main)) { supported = false; why = 'o serviço principal roda no navegador do Ulanzi (HTML), não em Node'; }   // o OpenWeather e similares
        else if (!m.jsOk) { supported = false; why = 'o serviço principal não é um script Node'; }
        else if (!fs.existsSync(path.join(root, m.main))) { supported = false; why = 'arquivo do serviço principal não encontrado'; }
        const prev = old.get(m.id);
        this.plugins.set(m.id, { dir, root, m, supported, why, proc: prev?.proc, sock: prev?.sock, wantRun: prev?.wantRun ?? false, restarts: prev?.restarts ?? [], failed: false, told: prev?.told ?? new Set(), activeTold: prev?.activeTold ?? new Map(), log: prev?.log ?? [] });
      } catch { /* manifesto inválido: ignora */ }
    }
    for (const p of this.plugins.values()) if (p.supported) applyPatches(p.m.id, p.root);
  }

  // EHOSTUNREACH também é o erro normal de um aparelho desligado. Só é "bloqueio do macOS" se este processo não alcança NEM um aparelho comprovadamente ligado (a placa, que acabou de falar com o servidor):
  // uma conexão recusada (ECONNREFUSED) ou aceita prova que o pacote chegou; EHOSTUNREACH com a placa ligada = rede local negada ao app.
  private lanProbe = { at: 0, denied: false, busy: false, detail: '' };
  private lanDenied(): boolean {
    const pr = this.lanProbe, peer = hooks.lanPeer?.();
    if (!peer) return pr.denied;   // sem aparelho de referência não dá para afirmar nada: mantém o último resultado
    if (!pr.busy && Date.now() - pr.at > 30_000) {
      pr.busy = true; const t0 = Date.now();
      const done = (denied: boolean, why: string) => { pr.denied = denied; pr.detail = `${peer}:80 ${why} ${Date.now() - t0}ms`; pr.at = Date.now(); pr.busy = false; };
      const s = net.connect({ host: peer, port: 80, timeout: 2500 });
      s.on('connect', () => { s.destroy(); done(false, 'conectou'); }).on('timeout', () => { s.destroy(); done(false, 'timeout'); }).on('error', (e: NodeJS.ErrnoException) => { s.destroy(); done(e.code === 'EHOSTUNREACH', String(e.code)); });
    }
    return pr.denied;
  }
  list(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => { const L = (s: string) => (getLang() === 'pt' ? undefined : p.m.locales?.[getLang()]?.[s]) ?? s; return {   // L: texto do manifesto no idioma do app (campo "locales" do plugin.json; sem tradução, fica o original)
      uuid: p.m.id, name: L(p.m.name), version: p.m.version ?? '', author: p.m.author ?? '', description: L(p.m.description ?? ''), dir: p.dir, supported: p.supported, why: p.why,
      running: !!p.proc, ready: !!p.sock && p.sock.readyState === WebSocket.OPEN, failed: p.failed, icon: p.m.icon ?? '', lanBlocked: lanBlocked(p.log) && this.lanDenied(), lanProbe: this.lanProbe.detail, uses: this.buttonsUsing(p.m.id).length,
      actions: p.m.actions.map((a) => ({ uuid: a.id, name: L(a.name), tooltip: L(a.tooltip ?? ''), hasPI: !!a.ui, icon: a.icon ?? '' })), log: p.log.slice(-40),
      dev: { linked: this.dev.links[p.m.id] ?? '', watching: this.dev.watch || !!this.dev.links[p.m.id], reloadedAt: this.devState.get(p.m.id)?.at ?? 0, reloadWhy: this.devState.get(p.m.id)?.why ?? '', error: this.devState.get(p.m.id)?.error ?? '' },
    }; });
  }

  // ================= importar do Ulanzi Studio =================
  availableToImport(): Importable[] {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(ULANZI_DIR).filter((d) => d.endsWith('.ulanziPlugin')).sort(); } catch { return []; }
    const out: Importable[] = [];
    for (const dir of dirs) {
      if (fs.existsSync(path.join(PLUGINS_DIR, dir))) continue;
      try {
        const root = path.join(ULANZI_DIR, dir), m = readManifest(root), supported = m.jsOk;
        out.push({ dir, name: m.name, version: m.version ?? '', supported, why: supported ? '' : 'o serviço principal roda no navegador do Ulanzi (HTML)', sensitive: fs.readdirSync(root).filter((f) => SENSITIVE.test(f)) });
      } catch { /* sem manifesto: ignora */ }
    }
    return out;
  }
  /** Copia o plugin da pasta do Ulanzi para PLUGINS_DIR (nunca roda nem altera a pasta original). */
  importPlugin(dir: string): void {
    if (!/^[A-Za-z0-9._-]+\.ulanziPlugin$/.test(dir)) throw new Error('nome de plugin inválido');   // a pasta do Ulanzi Studio só tem plugins no formato dele
    const src = path.join(ULANZI_DIR, dir), dst = path.join(PLUGINS_DIR, dir);
    if (!fs.existsSync(path.join(src, 'manifest.json'))) throw new Error('plugin não encontrado na pasta do Ulanzi Studio');
    if (fs.existsSync(dst)) throw new Error('plugin já importado');
    this.copyPlugin(src, dst);
  }

  /** Botões (de todas as páginas e subpastas) que usam uma ação do plugin. */
  private buttonsUsing(uuid: string): { pid: number; slot: number }[] {
    const out: { pid: number; slot: number }[] = [];
    for (const pg of this.store.cfg.pages) pg.buttons.forEach((b, slot) => { if (b.action?.type === 'plugin' && b.action.plugin === uuid) out.push({ pid: pg.id, slot }); });
    return out;
  }

  /** Apaga o plugin: para o processo, LIMPA todo botão que usa uma ação dele (qualquer página; o botão volta a vazio, mantendo o tamanho se for juntado),
   *  remove a pasta, as configurações globais e os ícones guardados. Devolve o nome e quantos botões foram limpos. */
  async removePlugin(uuid: string): Promise<{ name: string; cleared: number }> {
    const p = this.plugins.get(uuid); if (!p) throw new Error('plugin não encontrado');
    if (!/^[A-Za-z0-9._-]+\.(deckplugin|ulanziPlugin)$/.test(p.dir) || path.dirname(p.root) !== PLUGINS_DIR) throw new Error('pasta do plugin fora do lugar esperado: apague-a à mão');
    const used = this.buttonsUsing(uuid);
    for (const { pid, slot } of used) {
      const b = this.store.getPage(pid)!.buttons[slot]!;
      if (b.image) fs.rmSync(path.join(UPLOADS, b.image), { force: true });
      const span = b.span; Object.assign(b, { label: '', action: null, color: null, image: null }); b.imgrev++; if (span) b.span = span;
      invalidateRaw(pid, slot); if (pid === this.store.cfg.current) this.store.viewRev[slot]!++;
    }
    for (const [aid, a] of [...this.want.entries()]) if (a.plugin === uuid) { this.want.delete(aid); this.icons.delete(a.actionid); }
    this.stopPlugin(p);
    for (let i = 0; p.proc && i < 40; i++) await new Promise((r) => setTimeout(r, 100));   // espera o processo sair: no Windows a pasta fica travada (EPERM) enquanto ele roda dentro dela
    this.plugins.delete(uuid);
    fs.rmSync(p.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });   // tenta de novo se o Windows ainda estiver soltando a pasta
    fs.rmSync(this.globalFile(uuid), { force: true });
    this.store.gcFolders(); this.store.cfg.rev++; this.store.save();   // o botão "Subpasta" não vira plugin, mas a limpeza é barata e mantém o invariante
    this.scan(); this.queueSync();
    return { name: p.m.name, cleared: used.length };
  }

  /** Importa um plugin de QUALQUER lugar: pasta (com plugin.json ou, do Ulanzi Studio, manifest.json; ou que contenha a pasta do plugin) ou arquivo .zip. Valida o manifesto, não executa nada e devolve o nome. */
  importFromPath(srcPath: string, opts: { sub?: string; update?: boolean } = {}): { name: string; dir: string; updated?: boolean } {
    if (!path.isAbsolute(srcPath)) throw new Error('informe o caminho completo da pasta ou do .zip');
    const real = fs.realpathSync(srcPath);   // lança se não existir
    if (real === PLUGINS_DIR || real.startsWith(PLUGINS_DIR + path.sep)) throw new Error('esse plugin já está na pasta de plugins do app');
    let tmp = '', base = real;
    try {
      let root = real; const st = fs.statSync(real);
      if (st.isFile()) {
        if (!/\.zip$/i.test(real)) throw new Error('envie uma pasta ou um arquivo .zip');
        if (st.size > 200 * 1024 * 1024) throw new Error('arquivo grande demais (máximo 200 MB)');
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-'));
        try { platform.unzip(real, tmp); } catch { throw new Error('não consegui abrir o .zip'); }
        root = tmp; base = path.basename(real).replace(/\.zip$/i, '');
      } else base = path.basename(real);
      const hasM = (d: string) => fs.existsSync(path.join(d, 'plugin.json')) || fs.existsSync(path.join(d, 'manifest.json'));
      const subDirs = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== '__MACOSX' && e.name !== 'node_modules' && !e.name.startsWith('.')).map((e) => e.name); } catch { return []; } };
      if (opts.sub) {   // pasta do plugin dentro do repositório (URL .../tree/<ramo>/<pasta>); o zip do GitHub traz uma pasta-raiz única
        let repoRoot = root; const top = subDirs(root); if (!hasM(root) && top.length === 1 && fs.readdirSync(root).length === 1) repoRoot = path.join(root, top[0]!);
        const target = path.resolve(repoRoot, opts.sub);
        if (target !== repoRoot && !target.startsWith(repoRoot + path.sep)) throw new Error('pasta inválida');
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`a pasta "${opts.sub}" não existe no repositório`);
        root = target; base = path.basename(target);
      }
      if (!hasM(root)) {   // pasta que CONTÉM o plugin (ex.: zip com uma pasta dentro, ou repositório com o plugin numa subpasta): procura até 3 níveis
        const found: string[] = [];
        const walk = (d: string, depth: number) => { for (const k of subDirs(d)) { const full = path.join(d, k); if (hasM(full)) found.push(full); else if (depth < 3) walk(full, depth + 1); } };
        walk(root, 1);
        if (found.length > 1) throw new Error(`achei ${found.length} plugins aí (${found.slice(0, 5).map((f) => path.relative(root, f)).join(', ')}${found.length > 5 ? '…' : ''}): aponte para a pasta de um deles (…/tree/<ramo>/<pasta>)`);
        if (found.length !== 1) throw new Error('não achei um plugin aí: faltou o plugin.json (a pasta do plugin deve conter plugin.json, ou manifest.json no formato do Ulanzi Studio)');
        root = found[0]!; base = path.basename(root);
      }
      const m = readManifest(root);
      if (!m.jsOk) throw new Error(m.fmt === 'ulanzi' ? 'só plugins JavaScript (Type "JavaScript" e CodePath .js) são suportados; o serviço em HTML não roda aqui' : 'o "main" do plugin.json precisa ser um arquivo .js/.mjs');
      if (path.isAbsolute(m.main) || m.main.split(/[\\/]/).includes('..') || !fs.existsSync(path.join(root, m.main))) throw new Error(`"${m.main}" (serviço principal) não existe dentro do plugin`);
      const ext = m.fmt === 'deck' ? 'deckplugin' : 'ulanziPlugin';
      const slug = base.replace(PLUGIN_DIR_RE, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || m.id.replace(/[^A-Za-z0-9._-]+/g, '-');
      const dir = `${slug}.${ext}`, dst = path.join(PLUGINS_DIR, dir);
      const same = [...this.plugins.values()].find((p) => p.m.id === m.id);
      if (same && opts.update) { this.overlayPlugin(root, same.root); this.scan(); this.reloadPlugin(same.m.id, 'atualizado'); return { name: m.name, dir: same.dir, updated: true }; }   // mesmo id: atualiza no lugar (botões e configurações do plugin ficam)
      if (fs.existsSync(dst)) throw new Error(`já existe um plugin "${dir}" (apague a pasta dele em ${PLUGINS_DIR} para reimportar)`);
      if (same) throw new Error('já existe um plugin com o mesmo id (UUID)');
      this.copyPlugin(root, dst);
      return { name: m.name, dir };
    } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  /** Copia os arquivos de `src` POR CIMA de um plugin já instalado (atualização): não apaga nada que só exista lá e preserva configurações/segredos locais (config.json, certificados, buttons.json). */
  private overlayPlugin(src: string, dst: string): void {
    const srcReal = fs.realpathSync(src);
    fs.cpSync(src, dst, { recursive: true, force: true, filter: (s) => {
      if (/(^|[\\/])(\.git|__MACOSX|\.DS_Store)$/.test(s)) return false;
      const rel = path.relative(src, s), top = rel.split(path.sep)[0] ?? '';
      if (rel && !rel.includes(path.sep) && (/^(config|buttons)\.json$/.test(top) || SENSITIVE.test(top)) && fs.existsSync(path.join(dst, rel))) return false;   // a versão local desses arquivos vale
      try { if (fs.lstatSync(s).isSymbolicLink()) { const t = fs.realpathSync(s); return t === srcReal || t.startsWith(srcReal + path.sep); } } catch { return false; }
      return true;
    } });
    for (const f of fs.readdirSync(dst)) if (SENSITIVE.test(f)) fs.chmodSync(path.join(dst, f), 0o600);
  }

  // ================= recarregar (desenvolvimento) =================
  private devState = new Map<string, { at: number; why: string; error: string }>();   // uuid -> última recarga (para a tela de plugins)
  private dev: { watch: boolean; links: Record<string, string> } = { watch: false, links: {} };   // watch: recarrega ao salvar arquivos da cópia instalada; links: uuid -> pasta de origem (código-fonte do desenvolvedor)
  private watchers = new Map<string, fs.FSWatcher>(); private reloadTimers = new Map<string, NodeJS.Timeout>();
  private static DEV_FILE = () => path.join(DATA, 'plugin-dev.json');
  private static SRC_EXT = /\.(m?js|cjs|html?|css|png|gif|svg|jpe?g|json)$/i;
  private static STATE_FILES = /^(config|buttons|devices|state|settings|cache|data)\.json$/i;   // arquivos que o próprio plugin grava: não disparam recarga (senão entraria em laço)
  private loadDev(): void { try { const j = JSON.parse(fs.readFileSync(PluginHost.DEV_FILE(), 'utf8')); this.dev = { watch: !!j.watch, links: j.links && typeof j.links === 'object' ? j.links : {} }; } catch { /* padrão */ } }
  private saveDev(): void { try { fs.writeFileSync(PluginHost.DEV_FILE(), JSON.stringify(this.dev, null, 1), { mode: 0o600 }); } catch { /* só vale até reiniciar */ } }
  devInfo(): { watch: boolean; links: Record<string, string> } { return { watch: this.dev.watch, links: { ...this.dev.links } }; }

  /** Reinicia SÓ o serviço desse plugin (relê o manifesto): botões e configurações ficam; o ícone é redesenhado pelo plugin ao subir. */
  reloadPlugin(uuid: string, why = 'recarregado'): void {
    this.scan();
    const p = this.plugins.get(uuid); if (!p) return;
    this.devState.set(uuid, { at: Date.now(), why, error: '' });
    p.failed = false; p.restarts = [];
    const proc = p.proc;
    if (proc) { proc.once('exit', () => setTimeout(() => this.queueSync(), 100)); this.stopPlugin(p); } else this.queueSync();
    this.store.cfg.rev++;   // a página redesenha a lista de plugins
    console.log(`[plugins] ${p.m.name}: ${why}`);
  }
  private scheduleReload(key: string, fn: () => void): void { clearTimeout(this.reloadTimers.get(key)); this.reloadTimers.set(key, setTimeout(() => { this.reloadTimers.delete(key); try { fn(); } catch (e) { console.log(`[plugins] recarga falhou: ${e instanceof Error ? e.message : e}`); } }, 400)); }
  private watchTree(key: string, dir: string, onChange: () => void): void {
    this.unwatch(key);
    try {
      const w = fs.watch(dir, { recursive: true }, (_ev, f) => {
        const name = String(f ?? ''); if (!name || /(^|[\\/])(node_modules|\.git|__MACOSX)([\\/]|$)/.test(name)) return;
        const base = path.basename(name); if (!PluginHost.SRC_EXT.test(base) || PluginHost.STATE_FILES.test(base) || SENSITIVE.test(base)) return;
        this.scheduleReload(key, onChange);
      });
      w.on('error', () => this.unwatch(key)); this.watchers.set(key, w);
    } catch { /* sem suporte a observar essa pasta: sem recarga automática */ }
  }
  private unwatch(key: string): void { this.watchers.get(key)?.close(); this.watchers.delete(key); clearTimeout(this.reloadTimers.get(key)); this.reloadTimers.delete(key); }
  private rewatch(): void {
    for (const k of [...this.watchers.keys()]) this.unwatch(k);
    for (const p of this.plugins.values()) if (p.supported && this.dev.watch && !this.dev.links[p.m.id]) this.watchTree('i:' + p.m.id, p.root, () => this.reloadPlugin(p.m.id, 'recarregado (arquivo salvo)'));
    for (const [uuid, src] of Object.entries(this.dev.links)) this.watchTree('l:' + uuid, src, () => this.syncLink(uuid));
  }
  private syncLink(uuid: string): void {   // a pasta do desenvolvedor mudou: valida o manifesto, copia por cima da instalada e reinicia o plugin
    const src = this.dev.links[uuid], p = this.plugins.get(uuid); if (!src || !p) return;
    try {
      const m = readManifest(src);
      if (m.id !== uuid) throw new Error('o id do plugin.json mudou: desvincule e instale de novo');
      if (!fs.existsSync(path.join(src, m.main))) throw new Error(`"${m.main}" não existe`);
      this.overlayPlugin(src, p.root); this.reloadPlugin(uuid, 'recarregado (pasta vinculada)');
    } catch (e) { this.devState.set(uuid, { at: Date.now(), why: 'erro', error: e instanceof Error ? e.message : String(e) }); this.store.cfg.rev++; }   // manifesto quebrado no meio da edição: mantém a versão que roda
  }
  /** Liga/desliga a recarga automática dos arquivos das cópias instaladas (modo desenvolvedor). */
  setDevWatch(on: boolean): void { this.dev.watch = on; this.saveDev(); this.rewatch(); }
  /** Vincula uma pasta de código-fonte a um plugin instalado: ao salvar nela, o app copia para a instalada e reinicia só esse plugin. */
  linkDev(uuid: string, srcPath: string): void {
    const p = this.plugins.get(uuid); if (!p) throw new Error('plugin não encontrado');
    if (!path.isAbsolute(srcPath)) throw new Error('informe o caminho completo da pasta');
    let real: string; try { real = fs.realpathSync(srcPath); } catch { throw new Error('a pasta não existe'); }
    if (!fs.statSync(real).isDirectory()) throw new Error('informe uma pasta');
    if (real === PLUGINS_DIR || real.startsWith(PLUGINS_DIR + path.sep) || p.root === real) throw new Error('essa pasta é a própria cópia instalada: já recarrega no modo desenvolvedor');
    const m = readManifest(real);   // lança se não for um plugin
    if (m.id !== uuid) throw new Error('a pasta tem outro plugin (id diferente do instalado)');
    this.dev.links[uuid] = real; this.saveDev(); this.syncLink(uuid); this.rewatch();
  }
  unlinkDev(uuid: string): void { delete this.dev.links[uuid]; this.saveDev(); this.rewatch(); }

  private copyPlugin(src: string, dst: string): void {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    const srcReal = fs.realpathSync(src);
    fs.cpSync(src, dst, { recursive: true, filter: (s) => {
      if (/(^|[\\/])(\.git|__MACOSX|\.DS_Store)$/.test(s)) return false;
      try { if (fs.lstatSync(s).isSymbolicLink()) { const t = fs.realpathSync(s); return t === srcReal || t.startsWith(srcReal + path.sep); } } catch { return false; }   // atalho que aponta para fora do plugin: não copia
      return true;
    } });
    for (const f of fs.readdirSync(dst)) if (SENSITIVE.test(f)) fs.chmodSync(path.join(dst, f), 0o600);   // token/certificados: só o dono lê (a cópia do Ulanzi vem 0644)
    try {   // buttons.json guarda o estado dos botões do Ulanzi (chaves com o contexto deles): sem sentido aqui, e o plugin tentaria desenhar botões que não existem
      const bf = path.join(dst, 'buttons.json'), j = JSON.parse(fs.readFileSync(bf, 'utf8'));
      if (j && typeof j === 'object' && Object.keys(j).length && Object.keys(j).every((k) => k.includes('___'))) fs.writeFileSync(bf, '{}');
    } catch { /* não existe ou não é JSON: deixa */ }
    this.scan(); this.queueSync();
  }

  // ================= atribuições (botões que usam plugins) =================
  private collect(): Map<string, Assign> {
    const out = new Map<string, Assign>();
    for (const pg of this.store.cfg.pages) pg.buttons.forEach((b, slot) => {
      const a = b.action;
      if (a?.type === 'plugin' && a.plugin && a.action && a.actionid) {
        const key = keyOf(slot), ctx = `${a.action}___${key}___${a.actionid}`;
        out.set(ctx, { ctx, pid: pg.id, slot, plugin: String(a.plugin), action: String(a.action), actionid: String(a.actionid), key, settings: (a.settings ?? {}) as Record<string, any>, active: pg.id === this.store.cfg.current });
      }
    });
    return out;
  }
  private byActionId(actionid: string): Assign | undefined { for (const a of this.want.values()) if (a.actionid === actionid) return a; return undefined; }
  private assignOf(pid: number, slot: number): Assign | undefined { for (const a of this.collect().values()) if (a.pid === pid && a.slot === slot) return a; return undefined; }

  /** Atribui uma ação de plugin a um botão (novo actionid; configurações vazias). */
  assign(pid: number, i: number, pluginUuid: string, actionUuid: string): { actionid: string } {
    const p = this.plugins.get(pluginUuid), act = p?.m.actions.find((a) => a.id === actionUuid), b = this.store.getButton(pid, i);
    if (!p || !act || !b) throw new Error('plugin ou ação não encontrados');
    if (!p.supported) throw new Error(`plugin não suportado: ${p.why}`);
    const actionid = crypto.randomUUID();
    b.action = { type: 'plugin', plugin: p.m.id, action: act.id, actionid, settings: {} }; b.imgrev++;
    if (pid === this.store.cfg.current) this.store.viewRev[i]!++;
    this.store.cfg.rev++; p.failed = false; p.restarts = [];
    this.store.save();   // dispara o sync
    return { actionid };
  }

  /** URL da tela de configuração (property inspector) do plugin atribuído ao botão, para a página abrir num iframe. */
  piUrl(pid: number, i: number): { url: string; plugin: string; action: string; actionid: string } | null {
    const a = this.assignOf(pid, i);
    if (!a) return null;
    const p = this.plugins.get(a.plugin), act = p?.m.actions.find((x) => x.id === a.action);
    if (!p || !act?.ui) return null;
    const q = new URLSearchParams({ port: String(PLUGIN_PORT), address: '127.0.0.1', id: a.actionid, plugin: p.m.id, action: a.action, key: a.key, language: getLang() === 'en' ? 'en' : 'pt_BR',   // v2 (deck-ui.js)
      ...(p.m.fmt === 'ulanzi' ? { uuid: a.action, actionid: a.actionid, controller: 'Keypad', device: 'ES3C28P', mode: 'simulate' } : {}) });   // o legado precisa destes nomes e valores
    return { url: `/plugins/${encodeURIComponent(p.dir)}/${act.ui.split('/').map(encodeURIComponent).join('/')}?${q}`, plugin: p.m.name, action: act.name, actionid: a.actionid };
  }

  validate(A: Record<string, any>): Record<string, any> {
    if (!A.plugin && !A.action) throw new Error('escolha a ação do plugin');
    const p = this.plugins.get(String(A.plugin)), act = p?.m.actions.find((x) => x.id === A.action);
    if (!p || !act) throw new Error('plugin ou ação não encontrados (importe o plugin de novo)');
    if (!/^[0-9a-f-]{36}$/i.test(String(A.actionid))) throw new Error('atribua o plugin pelo seletor de plugins');
    const settings = A.settings && typeof A.settings === 'object' && !Array.isArray(A.settings) ? A.settings : {};
    if (JSON.stringify(settings).length > 50_000) throw new Error('configurações do plugin grandes demais');
    return { plugin: p.m.id, action: act.id, actionid: String(A.actionid), settings, ...(A.showText === true ? { showText: true } : {}) };   // showText: mostra na placa o texto que o plugin envia (padrão: não)
  }

  /** Arquivo estático de um plugin (tela de configuração, scripts, imagens); nunca arquivos de dados/segredos. */
  staticFile(urlPath: string): { file: string; ctype: string } | null {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(urlPath);
    if (!m) return null;
    let dir: string, rest: string;
    try { dir = decodeURIComponent(m[1]!); rest = decodeURIComponent(m[2]!); } catch { return null; }
    const p = [...this.plugins.values()].find((x) => x.dir === dir);
    if (!p || rest.includes('\0')) return null;
    const file = path.resolve(p.root, rest);
    if (!file.startsWith(p.root + path.sep) || !STATIC_EXT.test(file) || STATIC_DENY.test(path.basename(file))) return null;
    let real: string; try { real = fs.realpathSync(file); } catch { return null; }
    if (!real.startsWith(fs.realpathSync(p.root) + path.sep)) return null;   // link simbólico para fora do plugin
    return { file: real, ctype: CTYPES[path.extname(real).slice(1).toLowerCase()] ?? 'application/octet-stream' };
  }

  // ================= reconciliação =================
  queueSync(): void { clearTimeout(this.syncTimer); this.syncTimer = setTimeout(() => this.doSync(), 20); }

  private ref = (a: Assign): BtnRef => ({ id: a.actionid, action: a.action, key: a.key });
  private refOfCtx = (ctx: string): BtnRef => { const [action, key, id] = ctx.split('___') as [string, string, string]; return { id, action, key }; };

  private doSync(): void {
    if (this.stopping) return;
    const want = this.collect(); this.want = want;
    for (const a of want.values()) { const bt = this.store.getButton(a.pid, a.slot); if (bt && !this.icons.has(a.actionid)) this.placeholder(bt); }   // carrega de antemão o ícone padrão das ações (antes de o plugin mandar o dele)
    const used = new Set([...want.values()].map((a) => a.plugin));
    for (const [id, p] of this.plugins) { if (used.has(id)) this.ensureRunning(p); else if (p.wantRun) this.stopPlugin(p); }
    for (const p of this.plugins.values()) {
      if (!p.sock || p.sock.readyState !== WebSocket.OPEN) continue;
      for (const ctx of [...p.told]) if (!want.has(ctx)) {   // botão desatribuído
        this.out(p.sock, { k: 'remove', list: [this.refOfCtx(ctx)] }); p.told.delete(ctx); p.activeTold.delete(ctx);
      }
      for (const a of want.values()) if (a.plugin === p.m.id) {
        if (!p.told.has(a.ctx)) { this.out(p.sock, { k: 'add', a: this.ref(a), settings: a.settings }); p.told.add(a.ctx); p.activeTold.delete(a.ctx); }
        if (p.activeTold.get(a.ctx) !== a.active) { this.out(p.sock, { k: 'active', a: this.ref(a), active: a.active }); p.activeTold.set(a.ctx, a.active); }
      }
    }
    const ids = new Set([...want.values()].map((a) => a.actionid));
    for (const id of [...this.icons.keys()]) if (!ids.has(id)) this.icons.delete(id);
  }

  private ensureRunning(p: Plugin): void {
    if (!p.supported || p.failed) return;
    p.wantRun = true;
    if (p.proc) return;
    const child = spawn(process.execPath, [path.join(p.root, p.m.main), '127.0.0.1', String(PLUGIN_PORT), pluginLang(), APP_VERSION], { cwd: p.root, stdio: ['ignore', 'pipe', 'pipe'] });
    p.proc = child;
    const pipe = (s: NodeJS.ReadableStream) => s.on('data', (d) => String(d).trimEnd().split('\n').forEach((l) => { p.log.push(l); if (p.log.length > 60) p.log.shift(); if (process.env.DECK_PLUGIN_LOG) console.log(`[plugin:${p.m.name}] ${l}`); }));
    pipe(child.stdout); pipe(child.stderr);
    child.on('error', (e) => { p.log.push(`erro ao iniciar: ${e.message}`); });
    child.on('exit', (code, sig) => {
      p.proc = undefined; p.sock = undefined; p.told.clear(); p.activeTold.clear();
      if (this.stopping || !p.wantRun) return;
      const now = Date.now(); p.restarts = p.restarts.filter((t) => now - t < 60_000); p.restarts.push(now);
      console.log(`[plugins] ${p.m.name} encerrou (código ${code}, sinal ${sig})`);
      if (p.restarts.length > 5) { p.failed = true; console.log(`[plugins] ${p.m.name}: reiniciou demais, desisti`); return; }
      setTimeout(() => this.queueSync(), 1500);
    });
  }
  private stopPlugin(p: Plugin): void { p.wantRun = false; p.sock?.close(); p.proc?.kill('SIGTERM'); }

  // ================= mensagens =================
  /** Envia um evento do host para uma conexão, na língua dela (v2 ou legado). */
  private out(ws: WebSocket | undefined, o: Out): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const proto = this.meta.get(ws)?.proto; if (!proto) return;
    for (const m of (proto === 'deck' ? encodeDeck : encodeUlanzi)(o)) ws.send(JSON.stringify(m));
  }

  private onClose(ws: WebSocket): void {
    const meta = this.meta.get(ws); if (!meta) return;
    if (meta.role === 'pi' && meta.ctx) this.pis.get(meta.ctx)?.delete(ws);
    if (meta.role === 'main' && meta.plugin && meta.plugin.sock === ws) { meta.plugin.sock = undefined; meta.plugin.told.clear(); meta.plugin.activeTold.clear(); }
  }

  private onMessage(ws: WebSocket, msg: any): void {
    if (msg.type === 'hello') return this.onHello(ws, msg);        // registro (v2)
    if (msg.cmd === 'connected') return this.onConnectedLegacy(ws, msg);   // registro (legado do Ulanzi; 'connected' também traz code:0: não é um eco)
    const meta = this.meta.get(ws); if (!meta) return;
    if (meta.proto === 'ulanzi' && typeof msg.code !== 'undefined') return;   // o SDK do Ulanzi devolve um eco {code:0,...} de cada comando do host
    if (meta.proto === 'deck') { const ev = decodeDeck(msg); if (ev) this.handle(ws, meta, ev); else console.log(`[plugins] mensagem não tratada: ${msg.type}`); return; }
    for (const ev of decodeUlanzi(msg)) this.handle(ws, meta, ev);
  }

  /** Trata um evento normalizado vindo de uma conexão (serviço do plugin ou tela de configuração). */
  private handle(ws: WebSocket, meta: Meta, ev: In): void {
    const idOf = (id: string) => (meta.role === 'pi' ? meta.ctx! : this.byActionId(id)?.ctx ?? '');   // a tela de configuração só mexe no PRÓPRIO botão
    const A = (id: string): Assign | undefined => this.want.get(idOf(id));
    switch (ev.k) {
      case 'image': { const a = A(ev.id); if (meta.role === 'main' && a) void this.onImage(meta.plugin!, a, ev.image, ev.text); break; }
      case 'toast': if (this.toastWait) { const t = this.toastWait; this.toastWait = undefined; t.resolve(ev.message); } else console.log(`[plugins] toast sem toque pendente: ${ev.message}`); break;
      case 'alert': console.log(`[plugins] alerta no botão ${ev.id}`); break;
      case 'log': meta.plugin?.log.push(`[${ev.level}] ${ev.message}`); break;
      case 'hotkey': void this.runHotkey(ev.keys); break;
      case 'open': void this.openUrl(ev); break;
      case 'settings.get': { const a = A(ev.id); if (a) this.out(ws, { k: 'settings', a: this.ref(a), settings: this.settingsOf(a), via: 'save' }); break; }
      case 'settings.save': {
        const a = A(ev.id); if (!a) break;
        this.saveSettings(a, ev.settings);
        if (!ev.forward) this.fanout(a, { k: 'settings', a: this.ref(a), settings: this.settingsOf(a), via: 'save' }, meta.proto === 'deck' && meta.role === 'pi' ? ws : undefined);   // v2: a tela que salvou já sabe o que gravou (eco faria o formulário voltar atrás enquanto o usuário digita)
        else { const o: Out = { k: 'settings', a: this.ref(a), settings: this.settingsOf(a), via: 'forward' }; if (meta.role === 'pi') this.out(this.plugins.get(a.plugin)?.sock, o); else this.toPIs(a.ctx, o); }   // legado: a outra ponta recebe a configuração
        break;
      }
      case 'to.plugin': { const a = A(ev.id); if (meta.role === 'pi' && a) this.out(this.plugins.get(a.plugin)?.sock, { k: 'from.ui', a: this.ref(a), payload: ev.payload }); break; }
      case 'to.ui': { const a = A(ev.id); if (meta.role === 'main' && a) this.toPIs(a.ctx, { k: 'from.plugin', a: this.ref(a), payload: ev.payload }); break; }
      case 'global.get': { const id = meta.plugin?.m.id ?? this.pluginOfAction(ev.action ?? ''); if (id) this.out(ws, { k: 'global', id, settings: this.getGlobal(id), to: ev.action || id }); break; }
      case 'global.set': {
        const id = meta.plugin?.m.id ?? this.pluginOfAction(ev.action ?? ''); if (!id) break;
        this.setGlobal(id, ev.settings && typeof ev.settings === 'object' ? (ev.settings as Record<string, any>) : {});
        const o: Out = { k: 'global', id, settings: this.getGlobal(id) };
        this.out(this.plugins.get(id)?.sock, o); for (const [c, set] of this.pis) if (this.want.get(c)?.plugin === id) set.forEach((x) => this.out(x, o));
        break;
      }
      case 'unsupported': console.log(`[plugins] ${ev.what} não é suportado neste host`); break;
    }
  }

  private registerMain(ws: WebSocket, id: string, proto: Proto): void {
    const p = this.plugins.get(id);
    if (!p || !p.wantRun || !p.proc) { ws.close(); return; }                       // só plugins que NÓS iniciamos
    if (p.sock && p.sock.readyState === WebSocket.OPEN) { ws.close(); return; }   // um serviço principal por plugin: a primeira conexão vence (outro processo não derruba nem substitui o plugin em execução)
    p.sock = ws; p.told.clear(); p.activeTold.clear(); this.meta.set(ws, { role: 'main', proto, plugin: p });
    this.doSync();   // envia add/active de todos os botões deste plugin
  }
  private registerUi(ws: WebSocket, actionid: string, proto: Proto): void {
    const a = [...this.collect().values()].find((x) => x.actionid === actionid);   // tela de configuração: precisa corresponder a um botão atribuído
    if (!a) { ws.close(); return; }
    this.meta.set(ws, { role: 'pi', proto, ctx: a.ctx, plugin: this.plugins.get(a.plugin) });
    (this.pis.get(a.ctx) ?? this.pis.set(a.ctx, new Set()).get(a.ctx)!).add(ws);
    this.out(ws, { k: 'ui.init', a: this.ref(a), settings: a.settings });
  }
  private onHello(ws: WebSocket, msg: any): void {   // v2
    if (msg.role === 'plugin') this.registerMain(ws, String(msg.plugin ?? ''), 'deck');
    else if (msg.role === 'ui') this.registerUi(ws, String(msg.id ?? ''), 'deck');
    else ws.close();
  }
  private onConnectedLegacy(ws: WebSocket, msg: any): void {   // Ulanzi: o serviço principal tem UUID de 4 segmentos; a tela de configuração é identificada pelo contexto do botão
    const uuid = String(msg.uuid ?? '');
    if (uuid.split('.').length === 4) this.registerMain(ws, uuid, 'ulanzi'); else this.registerUi(ws, String(msg.actionid ?? ''), 'ulanzi');
  }
  private toPIs(ctx: string, o: Out): void { this.pis.get(ctx)?.forEach((s) => this.out(s, o)); }
  private fanout(a: Assign, o: Out, except?: WebSocket): void { this.out(this.plugins.get(a.plugin)?.sock, o); this.pis.get(a.ctx)?.forEach((x) => { if (x !== except) this.out(x, o); }); }
  private pluginOfAction(actionId: string): string { for (const p of this.plugins.values()) if (p.m.actions.some((x) => x.id === actionId)) return p.m.id; return ''; }

  // ---------- configurações (por botão, em config.json; globais, em DATA/plugin-settings) ----------
  private settingsOf(a: Assign): Record<string, any> { return (this.store.getButton(a.pid, a.slot)?.action?.settings ?? {}) as Record<string, any>; }
  private saveSettings(a: Assign, s: unknown): void {
    const b = this.store.getButton(a.pid, a.slot);
    if (!b?.action || b.action.type !== 'plugin' || b.action.actionid !== a.actionid) return;
    const obj = s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, any>) : {};
    if (JSON.stringify(obj).length > 50_000) return;
    b.action.settings = obj; this.store.save();
  }
  private globalFile = (uuid: string) => path.join(DATA, 'plugin-settings', uuid.replace(/[^\w.-]/g, '_') + '.json');
  private getGlobal(uuid: string): Record<string, any> { try { return JSON.parse(fs.readFileSync(this.globalFile(uuid), 'utf8')); } catch { return {}; } }
  private setGlobal(uuid: string, s: Record<string, any>): void { fs.mkdirSync(path.join(DATA, 'plugin-settings'), { recursive: true }); fs.writeFileSync(this.globalFile(uuid), JSON.stringify(s), { mode: 0o600 }); }

  // ================= ícones =================
  private async onImage(p: Plugin, a: Assign, im: import('./plugin-protocol.ts').ImageSpec, textRaw: string): Promise<void> {
    let raster: Raster | null = null, sig = '', anim: GifFrames | undefined;
    try {
      if (im.t === 'manifest') { const img = p.m.actions.find((x) => x.id === a.action)?.states[im.index]?.image; raster = img ? await this.fileRaster(p, img) : null; sig = `s${im.index}`; }
      else if (im.t === 'data' || im.t === 'gif') { sig = crypto.createHash('sha1').update(im.data).digest('hex'); raster = await this.dataRaster(im.data); if (im.t === 'gif') anim = this.gifOf(this.dataBuffer(im.data)); }
      else { sig = 'p' + im.path; raster = await this.fileRaster(p, im.path); if (im.t === 'gifFile') { const f = path.resolve(p.root, im.path); if (f.startsWith(p.root + path.sep) && fs.existsSync(f)) anim = this.gifOf(fs.readFileSync(f)); } }
    } catch (e) { console.log(`[plugins] ícone inválido de ${p.m.name}: ${e instanceof Error ? e.message : e}`); return; }
    const text = textRaw, prev = this.icons.get(a.actionid);
    if (prev && prev.sig === sig + '|' + text) return;   // plugins reenviam o mesmo ícone: não muda nada
    this.icons.set(a.actionid, { raster, text, ver: ++this.verCounter, sig: sig + '|' + text, anim });
    if (a.pid === this.store.cfg.current) { this.store.viewRev[a.slot]!++; this.store.cfg.rev++; }
  }
  private dataBuffer(data: string): Buffer { const m = /^data:[^;,]*(?:;[^,]*)?;base64,(.*)$/s.exec(data); return Buffer.from(m ? m[1]! : data, 'base64'); }
  /** GIF animado do ícone (null se não é GIF, tem 1 quadro ou passa dos limites): vira animação do botão. */
  private gifOf(buf: Buffer): GifFrames | undefined { if (!isGif(buf)) return undefined; try { const g = decodeGif(buf); return g.frames.length > 1 ? g : undefined; } catch { return undefined; } }
  private async dataRaster(data: string): Promise<Raster> { return decodeImageBuffer(this.dataBuffer(data)); }
  private async fileRaster(p: Plugin, rel: string): Promise<Raster | null> {
    const file = path.resolve(p.root, rel);
    if (!file.startsWith(p.root + path.sep) || !fs.existsSync(file)) return null;
    return decodeImageBuffer(fs.readFileSync(file));
  }
  private placeholder(b: Button): Raster | null {
    const act = this.plugins.get(String(b.action?.plugin))?.m.actions.find((x) => x.id === b.action?.action), p = this.plugins.get(String(b.action?.plugin));
    const rel = act?.states[0]?.image ?? act?.icon; if (!p || !rel) return null;
    const key = p.m.id + rel;
    if (!this.placeholders.has(key)) {
      this.placeholders.set(key, null);
      void this.fileRaster(p, rel).then((r) => {
        this.placeholders.set(key, r); if (!r) return;
        // o ícone padrão da ação chegou depois da 1ª imagem do botão (que saiu com "..."): refaz a imagem de cada botão que usa essa ação e avisa a placa
        for (const a of this.collect().values()) if (a.plugin === p.m.id && a.action === b.action?.action) {
          const bt = this.store.getButton(a.pid, a.slot); if (!bt) continue;
          if (!this.icons.has(a.actionid)) { bt.imgrev++; invalidateRaw(a.pid, a.slot); if (a.pid === this.store.cfg.current) this.store.viewRev[a.slot]!++; }
        }
        this.store.cfg.rev++;
      }).catch(() => {});
    }
    return this.placeholders.get(key) ?? null;
  }
  private labelFor(b: Button): string | undefined {
    const ic = this.icons.get(String(b.action?.actionid));
    if (ic?.text) return ic.text;
    return this.plugins.get(String(b.action?.plugin))?.m.actions.find((x) => x.id === b.action?.action)?.name;
  }
  private iconFor(b: Button): Raster | null { return this.icons.get(String(b.action?.actionid))?.raster ?? this.placeholder(b); }

  // ================= toque =================
  async press(pid: number, i: number): Promise<Result> {
    const a = this.assignOf(pid, i);
    if (!a) return [false, 'botão sem plugin'];
    const p = this.plugins.get(a.plugin);
    if (!p?.supported) return [false, 'plugin não suportado'];
    if (p.failed) return [false, 'o plugin falhou ao iniciar'];
    if (!p.sock || p.sock.readyState !== WebSocket.OPEN || !p.told.has(a.ctx)) { this.queueSync(); return [false, 'plugin iniciando, tente de novo'] }
    const wait = new Promise<string>((resolve) => { this.toastWait = { ctx: a.ctx, resolve }; setTimeout(() => { if (this.toastWait?.ctx === a.ctx) { this.toastWait = undefined; resolve(''); } }, 700); });
    this.out(p.sock, { k: 'press', a: this.ref(a), settings: this.settingsOf(a) });
    const toast = await wait;
    return [true, toast || 'ok'];
  }

  // ================= comandos do plugin para o sistema =================
  /** Converte "⌘C", "⌘⇧4", "^⌥M", "Ctrl+C" (notação do Ulanzi) para o nosso formato e envia a tecla. */
  async runHotkey(keylist: string): Promise<void> {
    const SYM: Record<string, string> = { '⌘': 'cmd', '⇧': 'shift', '⌥': 'alt', '^': 'ctrl', '⌃': 'ctrl' };
    let rest = keylist.trim(); const mods: string[] = [];
    while (rest && SYM[rest[0]!]) { mods.push(SYM[rest[0]!]!); rest = rest.slice(1); }
    const parts = rest.split('+').map((x) => x.trim()).filter(Boolean);
    const spec = [...mods, ...parts].join('+').toLowerCase();
    const [ok, msg] = await ACTIONS.hotkey!({ type: 'hotkey', keys: spec }, { store: this.store });
    if (!ok) console.log(`[plugins] hotkey "${keylist}" -> ${msg}`);
  }
  private async openUrl(ev: { url: string; params?: Record<string, string>; local: boolean }): Promise<void> {
    let url = ev.url;
    if (ev.local || !/^https?:\/\//i.test(url)) { console.log(`[plugins] openUrl só aceita http(s) externo: ${url}`); return; }
    if (ev.params && typeof ev.params === 'object') url += (url.includes('?') ? '&' : '?') + new URLSearchParams(ev.params).toString();
    const [ok, m] = await ACTIONS.url!({ type: 'url', url }, { store: this.store });
    if (!ok) console.log(`[plugins] openUrl: ${m}`);
  }
}
