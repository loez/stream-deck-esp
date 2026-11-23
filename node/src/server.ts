// Servidor HTTP: (1) página de configuração (localhost), (2) API da placa (/api/deck, /api/img/N.raw, /api/press/N, /api/pair) com token,
// (3) anúncio mDNS _streamdeck._tcp.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Bonjour } from 'bonjour-service';
import { PORT, DATA, WEB, UPLOADS, TOKEN_FILE, NOMDNS, DEFAULT_NAMES } from './env.ts';
import { LABEL_MAX, MAX_PAGES, PAGE_NAME_MAX, STRIDE, Store, newPage } from './config.ts';
import { limitsFor, parseSettings, parseScreen } from './settings.ts';
import { tr, trBody, getLang, dictFor, LANG_NAMES } from './i18n.ts';
import { hooks } from './hooks.ts';
import { platform } from './platform/index.ts';
import { readResources, resKey, resVer } from './resources.ts';
import { slide, refreshLevel, levelOf, sliderVer, sliderAxis, sliderColor, isAbsolute } from './slider.ts';
import type { SliderAct } from './slider.ts';
import { startUsbBridge } from './usb-port.ts';
import { getStandalone, setStandalone } from './standalone.ts';
import { widgetKey, widgetRefresh, ensureLocation } from './widgets.ts';
import { pushNotice, listNotices, unreadCount, dismissNotice, clearNotices, setNotifListener } from './notify.ts';
import { geocode } from './weather.ts';
import { haEntities } from './netactions.ts';
import { parseGithubUrl, downloadRepoZip } from './plugin-install.ts';
import type { UsbBridge } from './usb-port.ts';
import type { Button } from './config.ts';
import { fitLabel, labelFit, textWidth } from './fit.ts';
import { renderRaw, renderPreview, processUpload, pageIconFile, invalidateRaw, toRgb565 } from './render.ts';
import { buildProfile, iconCanvas, offlineReport } from './sa-profile.ts';
import { isGif, decodeGif, animTiles, planLimits, tileAnim, animRev, encodeAnim } from './anim.ts';
import { listApps, bundleIdOf } from './apps.ts';
import type { PluginHost } from './plugins.ts';
import type { AutoSwitch } from './focus.ts';
import { ACTIONS, MULTI_MODES, NO_HOLD, PAGE_OPS, ValueError, cleanAction, runAction, runCmd, toastFor } from './actions.ts';
import { stateKey, stateRefresh } from './state.ts';
import { exportBackup, parseBackup } from './backup.ts';
import { iconIndex, iconSvg, renderIcon, HEX, ICON_ID } from './icones.ts';
import { hexRgb, pyInt, pyStr, pyBool, slice, strip } from './util.ts';

// ---------- token de pareamento placa <-> Mac ----------
const newToken = () => crypto.randomBytes(24).toString('base64url');   // 32 caracteres, como o token_urlsafe(24) do Python
function loadToken(): string {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t.length >= 20) return t; } catch { /* gera abaixo */ }
  const t = newToken(); fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 }); fs.chmodSync(TOKEN_FILE, 0o600); return t;
}
let token = loadToken();
/** Token da extensão do Chrome (POST /api/notify): separado do token da placa, e só dá direito a enviar avisos. */
const NOTIFY_TOKEN_FILE = path.join(path.dirname(TOKEN_FILE), 'notify-key');
const loadNotifyToken = (): string => {
  try { const t = fs.readFileSync(NOTIFY_TOKEN_FILE, 'utf8').trim(); if (t.length >= 20) return t; } catch { /* gera abaixo */ }
  const t = newToken(); fs.mkdirSync(path.dirname(NOTIFY_TOKEN_FILE), { recursive: true }); fs.writeFileSync(NOTIFY_TOKEN_FILE, t, { mode: 0o600 }); fs.chmodSync(NOTIFY_TOKEN_FILE, 0o600); return t;
};
let notifyToken = loadNotifyToken();
const pairing = { until: 0 };   // segundos (epoch) até quando a janela de pareamento fica aberta
// Bateria (LiHV 4,35 V, divisor do GPIO9 com K=2,0; curva LiPo: 3,30 V = 0% .. 4,20 V = 100%). Sem bateria/leitura fora de 3,0-4,6 V: null.
const BAT_K = 2.0, BAT_CURVE: [number, number][] = [[3.30, 0], [3.50, 5], [3.60, 15], [3.70, 35], [3.80, 55], [3.90, 70], [4.00, 82], [4.10, 92], [4.20, 100]];
export function batteryInfo(mv: number): { mv: number; volts: number; percent: number } | null {
  const v = mv * BAT_K / 1000; if (!mv || v < 3.0 || v > 4.6) return null;
  let pc = 100; if (v <= BAT_CURVE[0]![0]) pc = 0; else for (let i = 1; i < BAT_CURVE.length; i++) if (v <= BAT_CURVE[i]![0]) { const [v0, p0] = BAT_CURVE[i - 1]!, [v1, p1] = BAT_CURVE[i]!; pc = p0 + (p1 - p0) * (v - v0) / (v1 - v0); break; }
  return { mv, volts: Math.round(v * 100) / 100, percent: Math.round(pc) };
}
// Tela da placa: brilho (10..100%, passos de 10) e apagar (a placa acorda no toque e avisa com woke=1). O brilho persiste em display.json.
const DISPLAY_FILE = path.join(DATA, 'display.json');
const display = { pct: 100, off: false };
let powerOffUntil = 0;   // desligar a placa: pedido de uso único (vale ~15 s e é entregue uma só vez em /api/deck; senão ela desligaria de novo ao religar)
try { const d = JSON.parse(fs.readFileSync(DISPLAY_FILE, 'utf8')); if (Number.isInteger(d.pct) && d.pct >= 10 && d.pct <= 100) display.pct = d.pct; } catch { /* padrão */ }
const displayBl = (): number => Math.round(display.pct * 2.55);
export function displayOp(op: string, value?: number): boolean {
  if (op === 'up') { display.pct = Math.min(100, display.pct + 10); display.off = false; }
  else if (op === 'down') { display.pct = Math.max(10, display.pct - 10); display.off = false; }
  else if (op === 'set' && Number.isFinite(value)) { display.pct = Math.min(100, Math.max(10, Math.round(value! / 10) * 10)); display.off = false; }
  else if (op === 'off') display.off = true;
  else if (op === 'on') display.off = false;
  else if (op === 'toggle') display.off = !display.off;
  else if (op === 'poweroff') { powerOffUntil = Date.now() + 15000; return true; }   // não grava em display.json
  else return false;
  try { fs.writeFileSync(DISPLAY_FILE, JSON.stringify({ pct: display.pct })); } catch { /* sem disco: vale só até reiniciar */ }
  return true;
}
const takePowerOff = (): { pwr?: true } => { if (Date.now() < powerOffUntil) { powerOffUntil = 0; return { pwr: true }; } return {}; };
const board: { ip: string | null; ts: number; press: unknown; unpaired_ip?: string; unpaired_ts?: number; caps: Set<string>; fill: number; batMv: number; saRev?: string } = { ip: null, ts: 0, press: null, caps: new Set(), fill: 0, batMv: 0 };   // caps: o que o firmware da placa sabe fazer ("tiles" = botões juntados), informado em /api/deck?cap=
const now = () => Date.now() / 1000;

export function lanIps(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  return out;
}

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
/** int() estrito do Python para pedaços de URL. */
const intOf = (s: string): number | null => (/^\s*[+-]?\d+\s*$/.test(s) ? Number(s.trim()) : null);

export function createServer(store: Store, host: PluginHost | null = null, focus: AutoSwitch | null = null): http.Server {
  const send = (res: http.ServerResponse, code: number, body: unknown = '', ctype = 'application/json') => {
    const buf = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(trBody(body)));   // trBody: mensagens (erro, msg, why, toast) no idioma escolhido
    res.writeHead(code, { 'Content-Type': ctype + (ctype.startsWith('text') || ctype === 'application/json' ? '; charset=utf-8' : ''), 'Content-Length': buf.length, 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(buf);
  };
  const readBody = (req: http.IncomingMessage, limit = 8_000_000): Promise<Buffer> => new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > limit) return reject(new Error('corpo grande demais'));
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('corpo grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
  const readJson = async (req: http.IncomingMessage, limit: number): Promise<any> => JSON.parse((await readBody(req, limit)).toString('utf8'));

  const remote = (req: http.IncomingMessage) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const isBoard = (req: http.IncomingMessage) => (req.headers['user-agent'] || '').startsWith('StreamDeckESP');
  /** Edição só pela própria máquina (e com Host de localhost: evita DNS rebinding). */
  const localOnly = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    const host = (req.headers.host || '').split(':')[0]!;
    if (!['127.0.0.1', '::1'].includes(remote(req)) || !['localhost', '127.0.0.1', '[::1]'].includes(host)) { send(res, 403, { erro: 'somente localhost' }); return false; }
    const origin = req.headers.origin;   // um site qualquer aberto no navegador pode mandar pedidos a localhost (CSRF): os pedidos da nossa página vêm do nosso próprio endereço (ou sem Origin)
    if (origin && !new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`]).has(origin)) { send(res, 403, { erro: 'origem não permitida' }); return false; }
    return true;
  };
  /** Pedidos que instalam código (plugins): além do localhost, exigem o tipo de conteúdo certo (um site de fora não consegue enviar application/json/zip sem pré-verificação, que o servidor não aceita). */
  const needType = (req: http.IncomingMessage, res: http.ServerResponse, want: RegExp): boolean => {
    if (want.test(String(req.headers['content-type'] ?? ''))) return true;
    send(res, 400, { erro: 'tipo de conteúdo inválido' }); return false;
  };
  /** Versão do ícone/texto de cada botão de plugin ("pagina:slot" -> versão): a página de configuração recarrega só a prévia do botão que mudou. */
  const pluginVers = (): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const pg of store.cfg.pages) pg.buttons.forEach((b, slot) => { if (b.action?.type === 'plugin') o[`${pg.id}:${slot}`] = hooks.pluginVersion?.(b) ?? 0; else if (b.action?.type === 'resources' || b.action?.type === 'widget' || b.action?.type === 'notif') o[`${pg.id}:${slot}`] = resVer.get(`${pg.id}:${slot}`) ?? 0; else if (b.action?.type === 'slider') o[`${pg.id}:${slot}`] = sliderVer.get(`${pg.id}:${slot}`) ?? 0; });
    return o;
  };
  /** Monitor de Recursos: enquanto existir algum botão desse tipo, lê o sistema a cada 2 s e, quando o valor que um botão mostra muda, sobe a versão dele (a placa e a prévia redesenham). */
  const resSeen = new Map<string, string>();
  const resTick = async () => {
    const slots: { pid: number; slot: number; kind: string }[] = [];
    for (const pg of store.cfg.pages) pg.buttons.forEach((b, slot) => { if (b.action?.type === 'resources') slots.push({ pid: pg.id, slot, kind: String(b.action.res ?? 'all') }); });
    if (!slots.length) { resSeen.clear(); return; }
    const r = await readResources().catch(() => null); if (!r) return;
    let changed = false;
    for (const { pid, slot, kind } of slots) {
      const k = `${pid}:${slot}`, key = resKey(kind, r);
      if (resSeen.get(k) === key) continue;
      resSeen.set(k, key); resVer.set(k, (resVer.get(k) ?? 0) + 1);
      if (pid === store.cfg.current) { store.viewRev[slot]!++; changed = true; }
    }
    if (changed) store.cfg.rev++;
  };
  if (!process.env.DECK_NORES) setInterval(() => { void resTick(); }, 2000).unref();
  /** Relógio e Clima (widgets.ts): a cada 15 s confere o que cada botão mostra (relógio: o minuto; clima: leitura nova, com cache de 10 min) e sobe a versão dele se mudou. */
  const wdSeen = new Map<string, string>();
  const widgetTick = async (fast = false) => {   // fast: só o "Tocando agora" (a cada 3 s); o normal cuida do relógio e do clima
    const slots: { pid: number; slot: number; kind: string }[] = [];
    for (const pg of store.cfg.pages) pg.buttons.forEach((b, slot) => { if (b.action?.type === 'widget' && (String(b.action.kind) === 'nowplaying') === fast) slots.push({ pid: pg.id, slot, kind: String(b.action.kind) }); });
    if (!slots.length) { if (!fast) wdSeen.clear(); return; }
    for (const kind of new Set(slots.map((s) => s.kind))) await widgetRefresh(kind).catch(() => {});
    let changed = false;
    for (const { pid, slot, kind } of slots) {
      const k = `${pid}:${slot}`, key = widgetKey(kind) + '|' + getStandalone().clock.h24 + getStandalone().tz + (getStandalone().weather?.name ?? '');
      if (wdSeen.get(k) === key) continue;
      wdSeen.set(k, key); resVer.set(k, (resVer.get(k) ?? 0) + 1);
      if (pid === store.cfg.current) { store.viewRev[slot]!++; changed = true; }
    }
    if (changed) store.cfg.rev++;
  };
  if (!process.env.DECK_NORES) { setInterval(() => { void widgetTick(); }, 15_000).unref(); setTimeout(() => { void widgetTick(); }, 1500).unref(); setInterval(() => { void widgetTick(true); }, 3000).unref(); }
  /** Notificações do navegador (notify.ts): a cada novidade, o botão "Notificações" e a página de histórico (se for a atual) redesenham na hora. */
  setNotifListener(() => {
    let changed = false;
    for (const pg of store.cfg.pages) pg.buttons.forEach((b, slot) => {
      if (!(b.action?.type === 'notif' || (b.action?.type === 'widget' && b.action.kind === 'notifications'))) return;
      const k = `${pg.id}:${slot}`; resVer.set(k, (resVer.get(k) ?? 0) + 1);
      if (pg.id === store.cfg.current) { store.viewRev[slot]!++; changed = true; }
    });
    if (changed) store.cfg.rev++;
  });
  /** Botões com estado (luz do Home Assistant, mudo): a cada 4 s relê o estado dos botões da página atual e, se mudou, redesenha só esses botões. Também roda ~1 s depois de qualquer toque. */
  const stateTick = async () => {
    const pg = store.getPage(store.cfg.current); if (!pg) return;
    const changed = await stateRefresh(pg.buttons.map((b) => b.action).filter((x): x is NonNullable<typeof x> => !!x));
    if (!changed.size) return;
    pg.buttons.forEach((b, slot) => { const k = stateKey(b.action); if (k && changed.has(k)) store.viewRev[slot]!++; });
    store.cfg.rev++;
  };
  if (!process.env.DECK_NORES) { setInterval(() => { void stateTick(); }, 4000).unref(); setTimeout(() => { void stateTick(); }, 2000).unref(); hooks.stateKick = () => { setTimeout(() => { void stateTick(); }, 900).unref(); }; }
  /** Controles deslizantes absolutos (volume): relê o nível do sistema a cada 3 s enquanto houver um na página atual (a placa e a prévia acompanham mudanças feitas por outro lado). */
  const sliderTick = async () => {
    const pg = store.getPage(store.cfg.current); if (!pg) return;
    for (let slot = 0; slot < pg.buttons.length; slot++) { const a = pg.buttons[slot]!.action; if (a?.type !== 'slider' || !isAbsolute(a)) continue; const k = `${pg.id}:${slot}`, before = levelOf(k); await refreshLevel(k, a as unknown as SliderAct); if (levelOf(k) !== before) store.cfg.rev++; }
  };
  if (!process.env.DECK_NORES) setInterval(() => { void sliderTick(); }, 3000).unref();
  /** Placa por cabo USB (túnel HTTP pela serial, usb.ts). Não roda em instâncias de teste (DECK_NOMDNS sem DECK_USB, DECK_DRYRUN ou DECK_NOUSB): senão uma placa de verdade seria tomada por elas. */
  const usb: UsbBridge | null = process.env.DECK_NOUSB || process.env.DECK_DRYRUN || (NOMDNS && !process.env.DECK_USB) ? null : startUsbBridge({ port: PORT, token: () => token, dataDir: DATA });
  /** Revisão do perfil autônomo (memoizada pela revisão da configuração + as configurações do modo autônomo): "0" = sem perfil. */
  let saMemo: { key: string; rev: string } | null = null;
  const saRev = (): string => { const key = store.cfg.rev + '|' + JSON.stringify(getStandalone()) + '|' + store.geom.cols + 'x' + store.geom.rows; if (!saMemo || saMemo.key !== key) saMemo = { key, rev: buildProfile(store)?.rev ?? '0' }; return saMemo.rev; };
  /** Chamadas da placa exigem o token no cabeçalho X-Deck (sem ele: 401; uma placa ainda não pareada aparece como "aguardando pareamento"). */
  const boardOk = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    if (safeEq(String(req.headers['x-deck'] || ''), token)) {
      // placa já pareada falando com o servidor e nenhuma placa não pareada esperando: não há o que parear, então a janela não deve ficar aberta
      if (pairing.until > now() && now() - (board.unpaired_ts ?? 0) > 10) { pairing.until = 0; console.log('[pareamento] janela fechada: a placa já está pareada'); }
      return true;
    }
    if (isBoard(req)) { board.unpaired_ip = remote(req); board.unpaired_ts = now(); }
    send(res, 401, { erro: 'não pareado' }); return false;
  };
  /** /api/<prefix>/<pid>/<i><tail> -> [pid, i] ou null */
  const ids = (p: string, prefix: string, tail = ''): [number, number] | null => {
    let rest = p.slice(prefix.length);
    if (tail) { if (!rest.endsWith(tail)) return null; rest = rest.slice(0, -tail.length); }
    const parts = rest.split('/'); if (parts.length !== 2) return null;
    const pid = intOf(parts[0]!), i = intOf(parts[1]!);
    return pid !== null && i !== null && i >= 0 && i < store.slots && store.getPage(pid) ? [pid, i] : null;   // aqui i é o slot da página (a placa usa o índice da grade, convertido)
  };
  const pageName = (id: number) => store.getPage(id)?.name;
  const headerText = (): string => {
    const pg = store.getPage(store.cfg.current)!, top = store.topPages(), n = top.length, idx = top.indexOf(pg) + 1;
    const suf = n > 1 && pg.parent === undefined ? `  ${idx}/${n}` : ''; let name = pg.name;   // subpasta: só o nome, sem "2/3"
    while (name && textWidth(name + suf, 12) > 150) name = strip(slice(name, 0, [...name].length - 1));
    return name + suf;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x'), p = url.pathname, method = req.method || 'GET';
    try {
      // ================= GET =================
      if (method === 'GET') {
        if (p === '/api/deck') {   // placa: sempre a página atual
          if (!boardOk(req, res)) return;
          const sc = parseScreen(url.searchParams.get('w'), url.searchParams.get('h'), url.searchParams.get('ppi'));   // a placa informa a tela (firmware antigo não informa: fica a última conhecida)
          if (sc && store.setScreen(sc)) console.log(`[placa] tela ${sc.w}x${sc.h} (${sc.ppi} ppi): grade recalculada`);
          const via = req.headers['x-deck-via'] === 'usb' ? 'USB' : remote(req);   // pedido repetido pela ponte do cabo (usb.ts)
          if (board.ip !== via) console.log(`[placa] conectada: ${via}`);
          board.ip = via; board.ts = now(); hooks.lanPeer = () => (now() - board.ts < 120 ? board.ip ?? undefined : undefined);
          board.saRev = url.searchParams.get('sa') ?? undefined; board.caps = new Set((url.searchParams.get('cap') ?? '').split(',').filter(Boolean)); board.fill = Number(url.searchParams.get('fill')) || 0; board.batMv = Number(url.searchParams.get('bmv')) || 0; if (url.searchParams.get('woke') === '1') display.off = false;   // acordou por toque   // fill: pixels/s que a placa aguenta animar
          const pg = store.getPage(store.cfg.current)!;
          const g = store.geom, boardIdx = Array.from({ length: g.count }, (_, k) => k);
          if (board.caps.has('tiles')) {   // firmware que desenha botões juntados: lista de botões com retângulo, faixa e texto de cada um (só os visíveis; células cobertas não aparecem)
            const tiles = store.tiles(pg.id), anims = board.caps.has('anim') ? animTiles(store, pg.id, tiles) : [], lim = planLimits(anims, board.fill), animBy = new Map<number, { n: number; rev: number }>();
            for (const at of anims) { try { animBy.set(at.slot, { n: tileAnim(at, lim).n, rev: animRev(at, lim) }); } catch (e) { console.log(`[anim] ${path.basename(at.key)}: ${e instanceof Error ? e.message : e}`); } }   // GIF com problema: o botão fica estático
            return send(res, 200, { rev: store.cfg.rev, bl: displayBl(), off: display.off, ...takePowerOff(), page: headerText(), sa: saRev(), t: Math.floor(Date.now() / 1000), cols: g.cols, rows: g.rows, w: g.w, h: g.h, bar: g.bar, font: g.font, top: g.top, tiles: true,
              buttons: tiles.map((t) => { const tb = store.tileBox(t.c, t.r), f = labelFit(pg.buttons[t.slot]!, pageName, tb); const sa = pg.buttons[t.slot]!.action; return { i: t.i, x: t.x, y: t.y, w: t.w, h: t.h, bar: tb.bar, label: f.text, fs: f.fs, img: store.viewRev[t.slot], ...((animBy.get(t.slot)?.n ?? 0) > 1 ? { anim: animBy.get(t.slot) } : {}),
                ...(sa?.type === 'slider' && board.caps.has('slide') ? { sl: { o: sliderAxis(sa, t.c, t.r), v: levelOf(`${pg.id}:${t.slot}`), r: isAbsolute(sa) ? 0 : 1, c: sliderColor(sa as unknown as SliderAct) } } : {}) }; }) });
          }
          return send(res, 200, { rev: store.cfg.rev, bl: displayBl(), off: display.off, ...takePowerOff(), page: headerText(), sa: saRev(), t: Math.floor(Date.now() / 1000), cols: g.cols, rows: g.rows, w: g.w, h: g.h, bar: g.bar, font: g.font, top: g.top,   // grade, botão e faixa do nome: a placa monta a tela com isto
            buttons: boardIdx.map((k) => { const slot = store.slotOfBoard(k)!, f = labelFit(pg.buttons[slot]!, pageName, g); return { label: f.text, fs: f.fs, img: store.viewRev[slot] }; }) });
        }
        if (p.startsWith('/api/anim/') && p.endsWith('.bin')) {   // placa: quadros do GIF do botão i (u16 n, u16 reservado, n x u16 atraso, n quadros RGB565)
          if (!boardOk(req, res)) return;
          const i = intOf(p.slice(10, -4)), tiles = store.tiles(store.cfg.current), anims = animTiles(store, store.cfg.current, tiles), at = anims.find((x) => x.i === i);
          if (!at) return send(res, 404, { erro: 'sem animação' });
          try { return send(res, 200, encodeAnim(tileAnim(at, planLimits(anims, board.fill))), 'application/octet-stream'); } catch { return send(res, 404, { erro: 'GIF inválido' }); }
        }
        if (p === '/api/sa') {   // placa: perfil autônomo (leva segredos: só com o token da placa ou pelo cabo)
          if (!boardOk(req, res)) return;
          const prof = buildProfile(store); if (!prof) return send(res, 404, { erro: 'sem perfil autônomo' });
          return send(res, 200, prof);
        }
        if (p.startsWith('/api/sa/img/') && p.endsWith('.raw')) {   // placa: imagem pronta (RGB565) de um botão do perfil
          if (!boardOk(req, res)) return;
          const prof = buildProfile(store), i = intOf(p.slice(12, -4)), t = prof?.tiles.find((x) => x.i === i), pg = prof ? store.getPage(getStandalone().page!) : null;
          const tile = pg && i !== null ? store.tiles(pg.id).find((x) => x.i === i) : null;
          if (!prof || !t || !tile || !pg || t.wd) return send(res, 404, { erro: '?' });   // relógio/clima a placa desenha sozinha
          return send(res, 200, await renderRaw(store, pg.id, tile.slot, true), 'application/octet-stream');
        }
        if (p.startsWith('/api/sa/icon/') && p.endsWith('.raw')) {   // placa: ícone do clima 48x48 (RGB565)
          if (!boardOk(req, res)) return;
          const cv = iconCanvas(p.slice(13, -4)); if (!cv) return send(res, 404, { erro: '?' });
          return send(res, 200, toRgb565(cv), 'application/octet-stream');
        }
        if (p.startsWith('/api/img/') && p.endsWith('.raw')) {   // placa: botão i da página atual
          if (!boardOk(req, res)) return;
          const i = intOf(p.slice(9, -4)), slot = i === null ? null : store.slotOfBoard(i), tiles = board.caps.has('tiles');
          if (slot === null || (tiles && !store.tiles(store.cfg.current).some((t) => t.i === i))) return send(res, 404, { erro: '?' });   // com botões juntados só existem as imagens dos botões visíveis (células cobertas: 404)
          return send(res, 200, await renderRaw(store, store.cfg.current, slot, tiles), 'application/octet-stream');
        }
        if (!localOnly(req, res)) return;
        if (p === '/' || p === '/index.html') return send(res, 200, fs.readFileSync(path.join(WEB, 'index.html')), 'text/html');
        if (p === '/api/i18n') return send(res, 200, { lang: getLang(), auto: store.settings.lang === undefined, langs: LANG_NAMES, dict: dictFor() });   // dicionário da página (auto: idioma ainda não escolhido)
        if (p === '/api/config') return send(res, 200, { ...store.cfg, ops: PAGE_OPS, modes: MULTI_MODES });
        if (p === '/deck-ui.js') return send(res, 200, fs.readFileSync(path.join(WEB, 'deck-ui.js')), 'text/javascript');   // SDK das telas de configuração dos plugins
        if (p.startsWith('/plugins/')) {   // arquivos da tela de configuração dos plugins (HTML, scripts, imagens; nunca arquivos de dados/segredos)
          const f = host?.staticFile(p); if (!f) return send(res, 404, { erro: 'não encontrado' });
          return send(res, 200, fs.readFileSync(f.file), f.ctype);
        }
        if (p === '/api/plugins') return send(res, 200, { enabled: !!host, plugins: host ? host.list() : [], dev: host ? host.devInfo() : { watch: false, links: {} } });
        if (p === '/api/plugins/available') return send(res, 200, host ? host.availableToImport() : []);
        if (p.startsWith('/api/button/') && p.endsWith('/plugin')) {   // atribuição atual e URL da tela de configuração do plugin
          const k = ids(p, '/api/button/', '/plugin'); if (!k) return send(res, 404, { erro: '?' });
          return send(res, 200, { pi: host?.piUrl(k[0], k[1]) ?? null });
        }
        if (p.startsWith('/api/page-icon/') && p.endsWith('.png')) {   // aba da página na configuração: ícone do app vinculado
          const pid = intOf(p.slice(15, -4)); if (pid === null || !store.getPage(pid)) return send(res, 404, { erro: '?' });
          const f = await pageIconFile(store, pid); if (!f) return send(res, 404, { erro: 'sem ícone' });
          return send(res, 200, fs.readFileSync(f), 'image/png');
        }
        if (p === '/api/apps') return send(res, 200, listApps());
        if (p === '/api/standalone') { void ensureLocation().catch(() => {}); const s = getStandalone(); return send(res, 200, { ...s, tzEffective: s.tz || Intl.DateTimeFormat().resolvedOptions().timeZone, rev: saRev(), boardRev: board.saRev ?? null, report: offlineReport(store) }); }   // configurações do modo autônomo / relógio / clima
        if (p === '/api/standalone/geocode') { if (!localOnly(req, res)) return; try { return send(res, 200, await geocode(url.searchParams.get('q') ?? '')); } catch (e) { return send(res, 400, { erro: e instanceof Error ? e.message : String(e) }); } }
        if (p === '/api/usb') return send(res, 200, usb?.status() ?? { enabled: false, state: 'off', port: null, board: null, requests: 0, error: null });   // estado da conexão por cabo
        if (p === '/api/resources') return send(res, 200, await readResources());   // CPU/RAM/GPU do computador (plugin "Monitor de Recursos")
        if (p === '/api/status') {
          const ago = board.ts ? now() - board.ts : null;
          return send(res, 200, { board_ip: board.ip, ago, connected: ago !== null && ago < 8, press: board.press, ips: lanIps(), port: PORT, battery: batteryInfo(board.batMv), display: { ...display }, current: store.cfg.current, rev: store.cfg.rev, pv: pluginVers(), ...(focus ? focus.status() : { front: null, enabled: false, on: false }),
            notif: { unread: unreadCount() }, pairing: Math.max(0, Math.trunc(pairing.until - now())), unpaired_ip: now() - (board.unpaired_ts ?? 0) < 10 ? (board.unpaired_ip ?? null) : null });
        }
        if (p === '/api/notifications') { if (!localOnly(req, res)) return; return send(res, 200, { unread: unreadCount(), items: listNotices() }); }   // lista para o painel da página
        if (p === '/api/notify/token') { if (!localOnly(req, res)) return; return send(res, 200, { token: notifyToken, port: PORT }); }   // mostrado na página para colar nas opções da extensão
        if (p === '/api/backup') {   // exporta a configuração (botões, páginas, imagens, grade) num arquivo; ?secrets=1 inclui tokens e senhas
          const body = Buffer.from(JSON.stringify(exportBackup(store, url.searchParams.get('secrets') === '1'))), stamp = new Date().toISOString().slice(0, 10);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="stream-deck-esp-backup-${stamp}.json"`, 'Cache-Control': 'no-store', Connection: 'close' }); return res.end(body);
        }
        if (p === '/api/icones') return send(res, 200, iconIndex());   // pacote local de ícones: índice de busca/categorias (nada vem da internet)
        if (p.startsWith('/api/icone/') && p.endsWith('.svg')) {   // /api/icone/l/house.svg?c=ffffff&w=2 (l = Lucide, s = logo de marca)
          const id = p.slice(11, -4).replace('/', ':'), c = '#' + (url.searchParams.get('c') || 'ffffff'), ic = ICON_ID.test(id) && HEX.test(c) ? iconSvg(id, c, Number(url.searchParams.get('w')) || 2) : null;
          return ic ? send(res, 200, ic.svg, 'image/svg+xml') : send(res, 404, { erro: '?' });
        }
        if (p.startsWith('/api/upload/')) {   // imagem/GIF enviado a um botão (a configuração mostra o GIF animado)
          const name = decodeURIComponent(p.slice(12));
          if (!/^p\d+_b\d+_\d+\.(png|gif)$/.test(name) || !fs.existsSync(path.join(UPLOADS, name))) return send(res, 404, { erro: '?' });
          return send(res, 200, fs.readFileSync(path.join(UPLOADS, name)), name.endsWith('.gif') ? 'image/gif' : 'image/png');
        }
        if (p.startsWith('/api/preview/') && p.endsWith('.png')) {
          const k = ids(p, '/api/preview/', '.png'); if (!k) return send(res, 404, { erro: '?' });
          return send(res, 200, await renderPreview(store, k[0], k[1]), 'image/png');
        }
        if (p === '/api/settings') return send(res, 200, { ...store.settings, geom: store.geom, limits: limitsFor(store.settings.screen), stride: STRIDE });   // grade e fonte atuais + geometria resultante
        if (p === '/api/fit') return send(res, 200, fitLabel(slice(url.searchParams.get('text') ?? '', 0, 200), false, store.geom));   // como o texto ficará na placa
        return send(res, 404, { erro: 'não encontrado' });
      }

      // ================= POST =================
      if (method === 'POST') {
        if (p === '/api/pair') {   // placa: recebe o token se a janela de pareamento estiver aberta (aberta pelo botão "Parear placa" na página local)
          if (!isBoard(req)) return send(res, 403, { erro: 'somente a placa' });
          board.unpaired_ip = remote(req); board.unpaired_ts = now();
          if (now() < pairing.until) { pairing.until = 0; console.log(`[pareamento] token entregue a ${remote(req)}`); return send(res, 200, { token }); }
          return send(res, 403, { erro: 'pareamento fechado' });
        }
        if (p.startsWith('/api/slide/')) {   // placa: dedo arrastando num botão-controle (v = posição 0-1000 ao longo do botão, p = 0 encostou / 1 arrastando / 2 soltou). Token como no toque
          if (!boardOk(req, res)) return;
          const bi = intOf(p.slice(11)), i = bi === null ? null : store.slotOfBoard(bi), v = Number(url.searchParams.get('v')), ph = Number(url.searchParams.get('p') ?? 1);
          const act = i === null ? null : store.getButton(store.cfg.current, i)?.action;
          if (bi === null || i === null || act?.type !== 'slider' || !Number.isFinite(v) || ![0, 1, 2].includes(ph) || (board.caps.has('tiles') && !store.tiles(store.cfg.current).some((t) => t.i === bi))) return send(res, 404, { erro: '?' });
          const r = slide(`${store.cfg.current}:${i}`, act as unknown as SliderAct, v, ph);
          if (ph === 2 && r.err) console.log(`[slider ${bi}] ${r.err}`);
          return send(res, 200, { ok: !r.err, v: r.level, err: r.err });
        }
        if (p === '/api/swipe/next' || p === '/api/swipe/prev') {   // placa: deslizar o dedo na grade troca de página (como os botões Próxima/Anterior)
          if (!boardOk(req, res)) return;
          const [ok, msg] = await ACTIONS.page!({ type: 'page', op: p.endsWith('next') ? 'next' : 'prev' }, { store, btn: [store.cfg.current, 0] });
          return send(res, ok ? 200 : 500, { ok, msg, quiet: true });
        }
        if (p.startsWith('/api/press/')) {   // placa (token no X-Deck: também impede disparo por páginas web de outros sites)
          if (!boardOk(req, res)) return;
          const bi = intOf(p.slice(11)), i = bi === null ? null : store.slotOfBoard(bi);
          if (bi === null || i === null || (board.caps.has('tiles') && !store.tiles(store.cfg.current).some((t) => t.i === bi))) return send(res, 404, { erro: '?' });
          const pid = store.cfg.current, kind = store.getButton(pid, i)?.action?.type, quiet = kind === 'page' || kind === 'folder';
          const [ok, msg] = await runAction(store, pid, i, url.searchParams.get('long') === '1'); board.press = { i: bi, ok, msg, t: now() };   // ?long=1: botão segurado (ação alternativa)
          const here = store.getPage(pid);   // subpasta com "voltar automaticamente": depois de uma ação de verdade, volta à página de origem
          if (ok && here?.autoBack && here.parent !== undefined && store.getPage(here.parent) && kind !== 'page' && kind !== 'folder' && store.cfg.current === pid) store.switchTo(here.parent, false);
          console.log(`[botao ${bi}] ${ok ? 'ok' : 'ERRO'} ${!ok ? msg : ''}`);
          return send(res, ok ? 200 : 500, { ok, msg, quiet: quiet && ok, toast: toastFor(store, pid, i, ok, msg) });   // quiet: navegação, a placa não mostra aviso
        }
        if (p === '/api/notify') {   // extensão do Chrome (extension/): token próprio no X-Deck-Notify; só aceita pedidos do próprio computador
          const host = (req.headers.host || '').split(':')[0]!;
          if (!['127.0.0.1', '::1'].includes(remote(req)) || !['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, { erro: 'somente localhost' });
          if (!safeEq(String(req.headers['x-deck-notify'] || ''), notifyToken)) return send(res, 401, { erro: 'token inválido' });
          if (!needType(req, res, /^application\/json/i)) return;
          let d: any; try { d = await readJson(req, 8192); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          const n = pushNotice({ source: d?.source, title: d?.title, body: d?.body, tag: d?.tag });
          return send(res, n ? 200 : 429, n ? { ok: true, id: n.id } : { erro: 'aviso vazio ou limite por minuto' });
        }
        if (!localOnly(req, res)) return;
        if (p === '/api/notifications/clear') { clearNotices(); return send(res, 200, { ok: true }); }
        if (p === '/api/notifications/dismiss') { let d: any; try { d = await readJson(req, 200); } catch { return send(res, 400, { erro: 'pedido inválido' }); } return send(res, dismissNotice(Number(d?.id)) ? 200 : 404, { ok: true }); }
        if (p === '/api/notify/token/reset') { notifyToken = newToken(); fs.writeFileSync(NOTIFY_TOKEN_FILE, notifyToken, { mode: 0o600 }); fs.chmodSync(NOTIFY_TOKEN_FILE, 0o600); return send(res, 200, { token: notifyToken }); }
        if (p.startsWith('/api/merge/') || p.startsWith('/api/unmerge/')) {   // juntar c x r células num só botão / separar
          const mg = /^\/api\/merge\/(\d+)$/.exec(p), um = /^\/api\/unmerge\/(\d+)\/(\d+)$/.exec(p), pid = Number((mg ?? um)?.[1] ?? -1), pgm = store.getPage(pid);
          if ((!mg && !um) || !pgm) return send(res, 400, { erro: 'pedido inválido' });
          let slots: number[];
          if (mg) {
            let d: any; try { d = await readJson(req, 1000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
            const err = store.merge(pid, Number(d.slot), Number(d.c), Number(d.r)); if (err) return send(res, 400, { erro: err });
            slots = store.rectSlots(Number(d.slot), Number(d.c), Number(d.r));
          } else {
            const slot = Number(um![2]), sp = store.spanOf(pid, slot); if (!store.unmerge(pid, slot)) return send(res, 400, { erro: 'este botão não está juntado' });
            slots = store.rectSlots(slot, sp.c, sp.r);
          }
          for (const i of slots) { const bt = pgm.buttons[i]; if (bt) { bt.imgrev++; invalidateRaw(pid, i); if (pid === store.cfg.current) store.viewRev[i]!++; } }
          store.cfg.rev++; store.save(); return send(res, 200, { ok: true });
        }
        if (p.startsWith('/api/swap/')) {   // arrastar e soltar na grade: troca dois botões de lugar (um deles pode estar vazio = mover)
          const m = /^\/api\/swap\/(\d+)\/(\d+)\/(\d+)$/.exec(p); const pg = m && store.getPage(Number(m[1]));
          const a = m ? Number(m[2]) : -1, b = m ? Number(m[3]) : -1;
          if (!m || !pg || a === b || a >= store.slots || b >= store.slots) return send(res, 400, { erro: 'posições inválidas' });
          const sa = store.spanOf(pg.id, a), sb = store.spanOf(pg.id, b), big = sa.c > 1 || sa.r > 1 || sb.c > 1 || sb.r > 1;
          if (big) {   // botão juntado: troca só com outro do mesmo tamanho, ou vai para um retângulo livre
            if (sa.c === sb.c && sa.r === sb.r) { /* mesmo tamanho: troca normal */ }
            else {
              const moving = sa.c > 1 || sa.r > 1 ? { from: a, to: b, sp: sa } : { from: b, to: a, sp: sb }, other = moving.from === a ? sb : sa;
              if (other.c > 1 || other.r > 1) return send(res, 400, { erro: 'botões juntados de tamanhos diferentes não trocam de lugar' });
              const col = moving.to % STRIDE, row = Math.floor(moving.to / STRIDE);
              if (col + moving.sp.c > store.geom.cols || row + moving.sp.r > store.geom.rows) return send(res, 400, { erro: 'o botão juntado não cabe ali' });   // grade visível: fora dela o botão sumiria da tela
              const mine = new Set(store.rectSlots(moving.from, moving.sp.c, moving.sp.r));
              for (const s of store.rectSlots(moving.to, moving.sp.c, moving.sp.r)) {   // o retângulo de destino só pode ter botões vazios e sem outro botão juntado
                if (mine.has(s)) continue; const bt = pg.buttons[s]!;
                if (bt.action || bt.label || bt.image) return send(res, 400, { erro: 'o destino do botão juntado precisa estar vazio' });
                if (store.spanOf(pg.id, s).c > 1 || store.spanOf(pg.id, s).r > 1) return send(res, 400, { erro: 'o destino cruza outro botão juntado' });
              }
              [pg.buttons[a], pg.buttons[b]] = [pg.buttons[b]!, pg.buttons[a]!];
              for (const i of store.rectSlots(moving.from, moving.sp.c, moving.sp.r).concat(store.rectSlots(moving.to, moving.sp.c, moving.sp.r))) { const bt = pg.buttons[i]; if (bt) { bt.imgrev++; invalidateRaw(pg.id, i); if (pg.id === store.cfg.current) store.viewRev[i]!++; } }
              store.cfg.rev++; store.save(); return send(res, 200, { ok: true });
            }
          }
          [pg.buttons[a], pg.buttons[b]] = [pg.buttons[b]!, pg.buttons[a]!];
          for (const i of [a, b]) { pg.buttons[i]!.imgrev++; invalidateRaw(pg.id, i); if (pg.id === store.cfg.current) store.viewRev[i]!++; }
          store.cfg.rev++; store.save();   // o salvamento também reenvia aos plugins a nova posição ("coluna_linha") dos botões deles
          return send(res, 200, { ok: true });
        }
        if (p.startsWith('/api/test/')) {
          const k = ids(p, '/api/test/'); if (!k) return send(res, 404, { erro: '?' });
          const [ok, msg] = await runAction(store, k[0], k[1]); return send(res, 200, { ok, msg });
        }
        if (p === '/api/backup') {   // importa um backup: guarda uma cópia da configuração atual em backups/, troca tudo e a placa relê
          if (!needType(req, res, /application\/json/i)) return;
          let parsed: ReturnType<typeof parseBackup>;
          try { parsed = parseBackup(await readJson(req, 300 * 1024 * 1024), store.slots); } catch (e) { return send(res, 400, { erro: e instanceof Error && !(e instanceof SyntaxError) ? e.message : 'arquivo de backup inválido' }); }
          const dir = path.join(DATA, 'backups'); fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `antes-da-importacao-${Date.now()}.json`), JSON.stringify(exportBackup(store, true)));   // rede de segurança (com segredos, só no disco do usuário como o config.json)
          fs.mkdirSync(UPLOADS, { recursive: true });
          for (const [n, buf] of Object.entries(parsed.files)) fs.writeFileSync(path.join(UPLOADS, n), buf);
          const used = new Set(parsed.cfg.pages.flatMap((pg) => pg.buttons.map((b) => b.image)));
          store.replaceConfig(parsed.cfg);
          try { for (const f of fs.readdirSync(UPLOADS)) if (/^p\d+_b\d+_\d+\.(png|gif)$/.test(f) && !used.has(f)) fs.rmSync(path.join(UPLOADS, f), { force: true }); } catch { /* sobras ficam */ }
          const sRes = parseSettings({ ...parsed.settings }, store.settings); if (typeof sRes !== 'string') store.setSettings(sRes);   // grade/fonte/idioma do backup (a tela da placa não)
          return send(res, 200, { ok: true, pages: parsed.cfg.pages.length });
        }
        if (p.startsWith('/api/button/') && p.endsWith('/icon')) {   // ícone do pacote local -> imagem do botão (PNG em uploads/, como o envio de imagem)
          const k = ids(p, '/api/button/', '/icon'); if (!k) return send(res, 404, { erro: '?' });
          let d: any; try { d = await readJson(req, 10_000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          const sp = store.spanOf(k[0], k[1]), tb = store.tileBox(sp.c, sp.r), id = pyStr(d.id), color = pyStr(d.color || '#ffffff'), bg = pyStr(d.bg || '#2b2f3f');
          let png: Buffer | null = null; try { png = await renderIcon(id, color, bg, Number(d.stroke) || 2, tb.w, tb.h, d.bar ? tb.bar : 0); } catch { /* ícone inválido */ }
          if (!png) return send(res, 400, { erro: 'ícone inválido' });
          fs.mkdirSync(UPLOADS, { recursive: true });
          const name = `p${k[0]}_b${k[1]}_${Date.now()}.png`; fs.writeFileSync(path.join(UPLOADS, name), png);
          const b = store.getButton(k[0], k[1])!, old = b.image; b.image = name; b.imgrev++; store.cfg.rev++;
          if (k[0] === store.cfg.current) store.viewRev[k[1]]!++;
          store.save(); if (old && old !== name) fs.rmSync(path.join(UPLOADS, old), { force: true });
          return send(res, 200, { ok: true });
        }
        if (p.startsWith('/api/button/') && p.endsWith('/image')) {
          const k = ids(p, '/api/button/', '/image'); if (!k) return send(res, 404, { erro: '?' });
          const [pid, i] = k; let png: Buffer; const body = await readBody(req, 26_000_000);
          if (isGif(body)) {   // GIF animado: guarda o original (a placa recebe os quadros já no tamanho do botão); a prévia e o firmware antigo usam o 1º quadro
            try { decodeGif(body); } catch (e) { return send(res, 400, { erro: e instanceof Error ? e.message : 'GIF inválido' }); }
            fs.mkdirSync(UPLOADS, { recursive: true });
            const gname = `p${pid}_b${i}_${Date.now()}.gif`; fs.writeFileSync(path.join(UPLOADS, gname), body);
            const gb = store.getButton(pid, i)!, gold = gb.image; gb.image = gname; gb.imgrev++; invalidateRaw(pid, i); store.cfg.rev++;
            if (pid === store.cfg.current) store.viewRev[i]!++;
            store.save(); if (gold && gold !== gname) fs.rmSync(path.join(UPLOADS, gold), { force: true });   // nunca apaga o arquivo que acabou de gravar
            return send(res, 200, { ok: true, gif: true });
          }
          try { png = await processUpload(body, store.tileBox(store.spanOf(k[0], k[1]).c, store.spanOf(k[0], k[1]).r).w, store.tileBox(store.spanOf(k[0], k[1]).c, store.spanOf(k[0], k[1]).r).h); } catch { return send(res, 400, { erro: 'imagem inválida' }); }
          fs.mkdirSync(UPLOADS, { recursive: true });
          const name = `p${pid}_b${i}_${Date.now()}.png`; fs.writeFileSync(path.join(UPLOADS, name), png);
          const b = store.getButton(pid, i)!, old = b.image; b.image = name; b.imgrev++; store.cfg.rev++;
          if (pid === store.cfg.current) store.viewRev[i]!++;
          store.save(); if (old && old !== name) fs.rmSync(path.join(UPLOADS, old), { force: true });
          return send(res, 200, { ok: true });
        }
        if (p === '/api/page') {   // nova página; o último botão já vem como "Início" para nunca ficar preso nela
          let name: string;
          try { const d = await readJson(req, 10_000); name = slice(strip(pyStr('name' in d ? d.name : '')), 0, PAGE_NAME_MAX); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          if (store.topPages().length >= MAX_PAGES) return send(res, 400, { erro: `máximo de ${MAX_PAGES} páginas` });
          const pid = store.cfg.next_id++, pg = newPage(pid, name || tr('Página {n}', { n: store.topPages().length + 1 }), store.slots);
          pg.buttons[(store.settings.rows - 1) * STRIDE + store.settings.cols - 1]!.action = { type: 'page', op: 'home' }; store.cfg.pages.push(pg); store.cfg.rev++; store.save();
          return send(res, 200, { ok: true, id: pid });
        }
        if (p === '/api/plugins/import') {   // copia um plugin da pasta do Ulanzi Studio (ação explícita do usuário na página)
          let dir: string;
          let srcPath = '';
          try { const b = await readJson(req, 10_000); dir = String(b.dir ?? ''); srcPath = String(b.path ?? ''); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          try {
            if (srcPath) { const r = host!.importFromPath(srcPath); return send(res, 200, { ok: true, name: r.name, dir: r.dir }); }   // de qualquer pasta ou .zip
            host!.importPlugin(dir);
          } catch (e) { return send(res, 400, { erro: e instanceof Error ? e.message : String(e) }); }
          return send(res, 200, { ok: true });
        }
        if (p === '/api/plugins/install-url') {   // instala (ou atualiza) um plugin a partir da URL de um repositório PÚBLICO do GitHub (ação explícita do usuário na página)
          if (!needType(req, res, /^application\/json/i)) return;
          if (!host) return send(res, 400, { erro: 'plugins desativados' });
          let d: any; try { d = await readJson(req, 4000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          let tmp = '';
          try {
            const g = parseGithubUrl(String(d.url ?? ''));
            tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-gh-')), 'repo.zip');
            await downloadRepoZip(g, tmp);
            const r = host.importFromPath(tmp, { sub: g.sub, update: d.update !== false });
            return send(res, 200, { ok: true, name: r.name, dir: r.dir, updated: !!r.updated, source: `github.com/${g.owner}/${g.repo}` });
          } catch (e) { return send(res, 400, { erro: e instanceof Error ? e.message : String(e) }); }
          finally { if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
        }
        if (p === '/api/plugins/upload') {   // .zip arrastado para a página: o corpo é o próprio arquivo
          if (!needType(req, res, /^application\/(zip|x-zip-compressed)/i)) return;
          if (!host) return send(res, 400, { erro: 'plugins desativados' });
          let body: Buffer; try { body = await readBody(req, 200 * 1024 * 1024); } catch { return send(res, 400, { erro: 'arquivo grande demais (máximo 200 MB)' }); }
          if (!body.length) return send(res, 400, { erro: 'arquivo vazio' });
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-zip-')), f = path.join(dir, 'plugin.zip');
          try { fs.writeFileSync(f, body, { mode: 0o600 }); const r = host.importFromPath(f, { update: true }); return send(res, 200, { ok: true, name: r.name, dir: r.dir, updated: !!r.updated }); }
          catch (e) { return send(res, 400, { erro: e instanceof Error ? e.message : String(e) }); }
          finally { fs.rmSync(dir, { recursive: true, force: true }); }
        }
        if (p === '/api/plugins/dev') {   // modo desenvolvedor: {watch: bool} recarrega as cópias instaladas ao salvar; {uuid, link: "/pasta"} vincula a pasta de código; {uuid, unlink: true}; {uuid, reload: true} reinicia o plugin
          if (!needType(req, res, /^application\/json/i)) return;
          if (!host) return send(res, 400, { erro: 'plugins desativados' });
          let d: any; try { d = await readJson(req, 4000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          try {
            if (typeof d.watch === 'boolean') host.setDevWatch(d.watch);
            if (d.uuid && typeof d.link === 'string') host.linkDev(String(d.uuid), d.link);
            if (d.uuid && d.unlink) host.unlinkDev(String(d.uuid));
            if (d.uuid && d.reload) host.reloadPlugin(String(d.uuid), 'recarregado (manual)');
            return send(res, 200, { ok: true, ...host.devInfo() });
          } catch (e) { return send(res, 400, { erro: e instanceof Error ? e.message : String(e) }); }
        }
        if (p === '/api/plugins/pick') {   // abre o seletor nativo de pasta/arquivo (ação explícita do usuário) e devolve o caminho escolhido
          let kind = 'folder'; try { kind = String((await readJson(req, 1000)).kind ?? 'folder'); } catch { /* padrão */ }
          if (process.env.DECK_DRYRUN) return send(res, 200, { path: '' });
          return send(res, 200, { path: await platform.pickPath(kind === 'zip' ? 'zip' : 'folder') });
        }
        if (p.startsWith('/api/button/') && p.endsWith('/plugin')) {   // atribui uma ação de plugin ao botão (imediato: a configuração do plugin vive na tela dele)
          const k = ids(p, '/api/button/', '/plugin'); if (!k) return send(res, 404, { erro: '?' });
          if (!host) return send(res, 400, { erro: 'plugins desativados' });
          let d: any; try { d = await readJson(req, 10_000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          try { const { actionid } = host.assign(k[0], k[1], String(d.plugin), String(d.action)); return send(res, 200, { ok: true, actionid, pi: host.piUrl(k[0], k[1]) }); }
          catch (e) { return send(res, 400, { erro: e instanceof Error ? e.message : String(e) }); }
        }
        if (p === '/api/display') {   // brilho / apagar a tela da placa (plugin "Bateria da Placa" e página): {op: up|down|set|off|on|toggle, value?}
          let d: any; try { d = await readJson(req, 1000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          if (!displayOp(String(d.op ?? ''), Number(d.value))) return send(res, 400, { erro: 'op inválida' });
          return send(res, 200, { ok: true, ...display });
        }
        if (p === '/api/standalone') {   // salva as configurações do modo autônomo (a página); os botões de relógio/clima redesenham sozinhos
          let d: any; try { d = await readJson(req, 4000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          try { const s = setStandalone(d); store.bumpAll(); return send(res, 200, { ok: true, ...s }); } catch (e) { return send(res, 400, { erro: e instanceof Error ? e.message : String(e) }); }
        }
        if (p === '/api/standalone/locate') {   // "usar minha localização": cidade aproximada pelo IP público
          const ok = await ensureLocation(true);
          return ok ? send(res, 200, { ok: true, ...getStandalone() }) : send(res, 400, { erro: 'não consegui descobrir a cidade pelo IP (sem internet?)' });
        }
        if (p === '/api/standalone/ha-entities') {   // lista as entidades do Home Assistant (para escolher no editor do botão)
          let d: any; try { d = await readJson(req, 2000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          try { return send(res, 200, await haEntities(String(d.url ?? ''), String(d.token ?? ''))); } catch (e) { return send(res, 400, { erro: e instanceof Error ? (e as any).cause?.code ? `não consegui falar com o Home Assistant (${(e as any).cause.code})` : e.message : String(e) }); }
        }
        if (p === '/api/usb') {   // liga/desliga a conexão por cabo (desligar solta a porta serial: necessário para gravar o firmware com o esptool)
          let d: any; try { d = await readJson(req, 1000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          if (!usb) return send(res, 400, { erro: 'conexão por cabo indisponível nesta instância' });
          usb.setEnabled(d.enabled !== false); return send(res, 200, { ok: true, ...usb.status() });
        }
        if (p === '/api/autoswitch') {   // liga/desliga a troca automática de página pelo app em foco
          let d: any; try { d = await readJson(req, 1000); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          if (d.enabled === false) store.cfg.autoswitch = false; else delete store.cfg.autoswitch;
          store.cfg.rev++; store.save(); focus?.refresh(); return send(res, 200, { ok: true, enabled: d.enabled !== false });
        }
        if (p === '/api/pairing/start') { pairing.until = now() + 90; return send(res, 200, { ok: true, seconds: 90 }); }   // abre a janela de pareamento (90 s)
        if (p === '/api/pairing/stop') { pairing.until = 0; return send(res, 200, { ok: true }); }
        if (p === '/api/token/reset') {   // revoga o token: a placa deixa de ter acesso até ser pareada de novo
          token = newToken(); fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 }); fs.chmodSync(TOKEN_FILE, 0o600); pairing.until = 0; board.ts = 0;
          console.log('[pareamento] token revogado'); return send(res, 200, { ok: true });
        }
        if (p.startsWith('/api/current/')) {   // mostrar esta página na placa
          const pid = intOf(p.slice(13));
          if (pid === null || !store.getPage(pid)) return send(res, 404, { erro: '?' });
          store.switchTo(pid); return send(res, 200, { ok: true });
        }
        return send(res, 404, { erro: 'não encontrado' });
      }

      // ================= PUT =================
      if (method === 'PUT') {
        if (!localOnly(req, res)) return;
        if (p === '/api/settings') {   // grade e fonte (a placa relê tudo e refaz a tela sozinha)
          let d: any; try { d = await readJson(req, 1000); if (d === null || typeof d !== 'object' || Array.isArray(d)) throw new Error('x'); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
          const r = parseSettings(d, store.settings); if (typeof r === 'string') return send(res, 400, { erro: r });
          store.setSettings(r); return send(res, 200, { ok: true, ...store.settings, geom: store.geom });
        }
        if (p.startsWith('/api/page/')) {   // renomear / mover
          let pid: number | null, d: any;
          try { pid = intOf(p.slice(10)); d = await readJson(req, 10_000); if (pid === null || !store.getPage(pid) || d === null || typeof d !== 'object' || Array.isArray(d)) throw new Error('x'); }
          catch { return send(res, 400, { erro: 'pedido inválido' }); }
          let apps: { name: string; bundle: string }[] | undefined;
          if ('apps' in d) {   // apps vinculados à página (aparece quando um deles está em foco)
            if (!Array.isArray(d.apps) || d.apps.length > 10) return send(res, 400, { erro: 'lista de apps inválida (até 10)' });
            apps = [];
            for (const a of d.apps) {
              if (!a || typeof a !== 'object') return send(res, 400, { erro: 'app inválido' });
              const name = slice(strip(pyStr(a.name ?? '')), 0, 120); let bundle = slice(strip(pyStr(a.bundle ?? '')), 0, 200);
              if (!name) return send(res, 400, { erro: 'app sem nome' });
              if (!bundle && typeof a.path === 'string' && a.path) bundle = await bundleIdOf(a.path);
              if (!apps.some((x) => x.name.toLowerCase() === name.toLowerCase() && x.bundle === bundle)) apps.push({ name, bundle });
            }
          }
          const pages = store.cfg.pages, pg = store.getPage(pid)!;
          if (apps) { if (apps.length) pg.apps = apps; else delete pg.apps; }
          if ('name' in d) { const nm = slice(strip(pyStr(d.name)), 0, PAGE_NAME_MAX); if (nm) pg.name = nm; }
          if ('autoBack' in d && pg.parent !== undefined) { if (d.autoBack === true) pg.autoBack = true; else delete pg.autoBack; }   // só vale em subpasta
          if (d.move === -1 || d.move === 1) { const k = pages.indexOf(pg); let j = k + d.move; while (j >= 0 && j < pages.length && pages[j]!.parent !== undefined) j += d.move; if (j >= 0 && j < pages.length) [pages[k], pages[j]] = [pages[j]!, pages[k]!]; }   // pula as subpastas
          if (apps && !DEFAULT_NAMES) store.bumpAll();   // o ícone sugerido dos botões "ir para" depende dos apps vinculados
          store.cfg.rev++; store.save(); if (apps) focus?.refresh();   // nome/ordem aparecem no cabeçalho e nos botões "ir para" (a placa relê o texto a cada consulta; imagens não mudam)
          return send(res, 200, { ok: true });
        }
        if (!p.startsWith('/api/button/')) return send(res, 404, { erro: 'não encontrado' });
        const k = ids(p, '/api/button/'); if (!k) return send(res, 404, { erro: '?' });
        const [pid, i] = k; let d: any;
        try { d = await readJson(req, 100_000); if (d === null || typeof d !== 'object' || Array.isArray(d)) throw new Error('x'); } catch { return send(res, 400, { erro: 'pedido inválido' }); }
        const b = store.getButton(pid, i)!; let imgChanged = false;
        const lbl = strip(slice(pyStr('label' in d ? d.label : b.label), 0, LABEL_MAX));
        let incoming = 'action' in d ? d.action : b.action;
        // plugin já atribuído: a página não é dona das configurações dele (a tela do plugin as grava): mantém o que está salvo
        if (incoming?.type === 'plugin' && b.action?.type === 'plugin' && incoming.actionid === b.action.actionid) { const { showText: _drop, ...keep } = b.action; incoming = { ...keep, ...(incoming.showText === true ? { showText: true } : {}) }; }   // só "mostrar texto" vem da página
        let act;
        try { act = cleanAction(incoming); } catch (e) { if (e instanceof ValueError) return send(res, 400, { erro: e.message }); throw e; }
        if (act?.type === 'folder') {   // subpasta: cria (ou reaproveita) a página oculta da pasta, já com o botão "Voltar" no 1º slot
          if (store.cfg.pages.length >= 200) return send(res, 400, { erro: 'subpastas demais' });
          const here = store.getPage(pid)!, name = slice(lbl || tr('Pasta'), 0, PAGE_NAME_MAX);
          let fp = act.page !== undefined ? store.getPage(Number(act.page)) : undefined;
          if (!fp || fp.parent !== pid) {   // nova (ou a página apontada não é uma pasta desta página)
            const fid = store.cfg.next_id++; fp = newPage(fid, name, store.slots); fp.parent = pid;
            fp.buttons[0] = { label: tr('Voltar'), action: { type: 'page', op: 'up' }, color: null, image: null, imgrev: 1 };
            store.cfg.pages.push(fp);
          }
          fp.name = name; act.page = fp.id;
        }
        let alt = 'alt' in d ? d.alt : (b.alt ?? null);   // ação ao segurar (opcional)
        try { alt = cleanAction(alt); } catch (e) { if (e instanceof ValueError) return send(res, 400, { erro: e.message }); throw e; }
        if (alt && (NO_HOLD.includes(alt.type) || alt.type === 'plugin')) return send(res, 400, { erro: 'esta ação não pode ser usada ao segurar o botão' });
        let color = 'color' in d ? d.color : b.color; color = typeof color === 'string' && hexRgb(color) ? color : null;
        if (!isDeepStrictEqual(act, b.action) || color !== b.color || (!DEFAULT_NAMES && !lbl !== !b.label)) imgChanged = true;   // título que aparece/some muda a faixa e o tamanho do ícone
        if (pyBool(d.clearImage) && b.image) { fs.rmSync(path.join(UPLOADS, b.image), { force: true }); b.image = null; imgChanged = true; }
        b.label = lbl; b.action = act; b.color = color; if (alt) b.alt = alt; else delete b.alt;
        if (imgChanged) b.imgrev++;
        if (pid === store.cfg.current && imgChanged) store.viewRev[i]!++;
        store.gcFolders();   // o botão deixou de ser "Subpasta": a pasta e o que tinha nela são apagados
        store.cfg.rev++; store.save();
        return send(res, 200, { ok: true });
      }

      // ================= DELETE =================
      if (method === 'DELETE') {
        if (!localOnly(req, res)) return;
        if (p.startsWith('/api/plugins/')) {   // apaga um plugin importado e limpa todo botão que o usa
          if (!host) return send(res, 400, { erro: 'plugins desativados' });
          try { return send(res, 200, { ok: true, ...await host.removePlugin(decodeURIComponent(p.slice(13))) }); } catch (e) { return send(res, 400, { erro: e instanceof Error ? e.message : String(e) }); }
        }
        if (!p.startsWith('/api/page/')) return send(res, 404, { erro: 'não encontrado' });
        const pid = intOf(p.slice(10));
        if (pid === null || !store.getPage(pid)) return send(res, 404, { erro: '?' });
        const pg = store.getPage(pid)!;
        if (pg.parent !== undefined) return send(res, 400, { erro: 'esta é uma subpasta: limpe o botão "Subpasta" para apagá-la' });
        if (store.topPages().length <= 1) return send(res, 400, { erro: 'é preciso manter pelo menos uma página' });
        for (const bb of pg.buttons) if (bb.image) fs.rmSync(path.join(UPLOADS, bb.image), { force: true });
        store.cfg.pages.splice(store.cfg.pages.indexOf(pg), 1); store.history = store.history.filter((h) => h !== pid);
        if (store.cfg.current === pid) { store.cfg.current = store.topPages()[0]!.id; store.bumpAll(); }   // a placa mostrava a página apagada: troca as imagens
        store.gcFolders();   // as subpastas dela vão junto
        store.cfg.rev++; store.save();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { erro: 'não encontrado' });
    } catch (e) {
      console.error('[erro]', method, p, e);
      if (!res.headersSent) send(res, 500, { erro: 'erro interno' });
    }
  });
}

export function advertise(port: number): (() => void) | null {
  if (NOMDNS) return null;
  const host = os.hostname().split('.')[0], name = process.env.DECK_MDNS_NAME || `Stream Deck (${host})`;
  let bonjour: Bonjour | null = null, svc: any = null, failed = false, stopped = false, lastLog = 0;
  // Um erro de multicast (ex.: macOS sem a permissão "Rede local" para o app: EHOSTUNREACH em 224.0.0.251) NÃO pode derrubar o servidor:
  // registra (no máximo 1x por minuto) e tenta anunciar de novo a cada 30 s; a placa também pode usar o endereço fixo (serial: H a.b.c.d).
  const onError = (e: unknown) => {
    failed = true;
    if (Date.now() - lastLog > 60_000) { lastLog = Date.now(); console.log(`[mdns] anúncio falhou (${e instanceof Error ? e.message : e}). No macOS, libere "Rede local" para o app em Ajustes do Sistema > Privacidade e Segurança.`); }
  };
  const start = () => {
    failed = false;
    try { bonjour = new Bonjour(undefined, onError); svc = bonjour.publish({ name, type: 'streamdeck', protocol: 'tcp', port, txt: { v: '1' } }); } catch (e) { onError(e); }
  };
  const teardown = () => { try { svc?.stop?.(() => bonjour?.destroy()); } catch { /* já parado */ } try { bonjour?.destroy(); } catch { /* idem */ } bonjour = null; svc = null; };
  start();
  const retry = setInterval(() => { if (failed && !stopped) { teardown(); start(); } }, 30_000); retry.unref();
  return () => { stopped = true; clearInterval(retry); teardown(); };
}
