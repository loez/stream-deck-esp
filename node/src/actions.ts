// Ações (o que acontece ao tocar um botão). Mesmo conjunto e mesmas regras de validação do servidor Python: app, url, hotkey, text, media, multi, page.
// Para criar um novo tipo: registrar uma função em ACTIONS (e validar os campos em cleanAction).
import { platform } from './platform/index.ts';
import type { Action, Store } from './config.ts';
import { effectiveLabel, MEDIA_KEYS, sanitizeGlyphs } from './fit.ts';
import { hooks } from './hooks.ts';
import { tr } from './i18n.ts';
import { RES_KINDS, readResources } from './resources.ts';
import { SLIDER_MODES, SLIDER_APPS } from './slider.ts';
import { cleanNet, runWebhook, runHomeAssistant, runMqtt } from './netactions.ts';
import { WIDGET_KINDS, widgetRefresh } from './widgets.ts';
import { notifPress, openHistory } from './notify.ts';
import { pyBool, pyInt, pyStr, slice, sleep, strip } from './util.ts';

export type Result = [boolean, string];
export type Ctx = { store: Store; btn?: [number, number] };
type ActionFn = (a: Action, ctx: Ctx) => Promise<Result>;

/** Erro de validação com mensagem para o usuário (ValueError do Python). */
export class ValueError extends Error {}

// ---------- comandos do sistema (em exec.ts) ----------
export { cleanEnv, runCmd, axError } from './exec.ts';

// ---------- atalhos ----------
export const MODS: Record<string, string> = { cmd: 'command', command: 'command', ctrl: 'control', control: 'control', alt: 'option', opt: 'option', option: 'option', shift: 'shift' };
export const KEYCODES: Record<string, number> = { return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, esc: 53, escape: 53, forwarddelete: 117, left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
type Key = ['code', number] | ['char', string];

export function parseHotkey(text: unknown): [string[], Key, string] {
  const parts = pyStr(text).split('+').map((p) => strip(p).toLowerCase()).filter((p) => p);
  if (!parts.length) throw new ValueError('atalho vazio');
  const key = parts[parts.length - 1]!, mods: string[] = [];
  for (const m of parts.slice(0, -1)) {
    if (!(m in MODS)) throw new ValueError(`modificador inválido: ${m}`);
    if (!mods.includes(MODS[m]!)) mods.push(MODS[m]!);
  }
  if (key in KEYCODES) return [mods, ['code', KEYCODES[key]!], parts.join('+')];
  if ([...key].length === 1 && (/^[a-z0-9]$/i.test(key) || '-=[];\',./`'.includes(key))) return [mods, ['char', key], parts.join('+')];
  throw new ValueError(`tecla inválida: ${key}`);
}

export { keystrokeScript } from './platform/mac.ts';   // script do macOS (compatibilidade com os testes)

// ---------- ações ----------

export const MULTI_MODES: Record<string, string> = { seq: 'Em sequência', par: 'Todas ao mesmo tempo', cycle: 'Alternar (cada toque executa o próximo passo)', random: 'Sorteio (um passo aleatório por toque)' };
export const PAGE_OPS = ['next', 'prev', 'home', 'back', 'goto'];
const cycleState = new Map<string, number>();   // "pagina:botao" -> índice do próximo passo (modo "alternar"); só em memória

export const ACTIONS: Record<string, ActionFn> = {
  async app(a) {
    const p = a.path ? String(a.path) : '', name = strip(String(a.app ?? ''));
    return platform.openApp(name, p && platform.isAppPath(p) ? p : '');
  },
  /** Fecha um aplicativo (só se estiver aberto). Usa o caminho do app, ou o nome. */
  async quitapp(a) {
    const p = a.path ? String(a.path) : '', name = strip(String(a.app ?? '')), target = p && platform.isAppPath(p) ? p : name;
    if (!target) return [false, 'sem aplicativo'];
    return platform.quitApp(target);
  },
  /** Abre uma subpasta (página oculta). O botão "Voltar" dela já vem criado e leva de volta à página de origem. */
  async folder(a, ctx) {
    const t = pyInt(a.page);
    if (t === null || !ctx.store.getPage(t)) return [false, 'a pasta não existe mais'];
    ctx.store.switchTo(t); return [true, 'ok'];
  },
  async url(a) {
    let u = strip(String(a.url ?? ''));
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) { if (u.includes('.') && !u.includes(' ')) u = 'https://' + u; else return [false, 'endereço inválido']; }
    if (u.toLowerCase().startsWith('file:')) return [false, 'esquema file: não é permitido'];   // abriria/executaria arquivos locais
    return platform.openUrl(u);
  },
  async hotkey(a) {
    const [mods, key] = parseHotkey(a.keys);
    return platform.hotkey(mods, key);
  },
  /** Digita o texto colando-o (Cmd/Ctrl+V) ou digitando (Linux): funciona com acentos e emojis. A área de transferência é restaurada quando possível. */
  async text(a) {
    const t = pyStr(a.text ?? '');
    if (!t) return [false, 'texto vazio'];
    return platform.typeText(t, !!a.enter);
  },
  async media(a) {
    const k = a.key as string;
    if (!(k in MEDIA_KEYS)) return [false, 'tecla de mídia inválida'];
    return platform.media(k);
  },
  /** Várias ações num botão: seq (em sequência, segundo plano), par (todas juntas), cycle (próximo passo a cada toque), random (um sorteado). */
  async multi(a, ctx) {
    const steps: Action[] = a.steps || [], mode = a.mode ?? 'seq', n = steps.length;
    if (!n) return [false, 'sequência vazia'];
    if (mode === 'par') {
      const results: (Result | null)[] = Array(n).fill(null);
      const all = Promise.all(steps.map(async (s, k) => { results[k] = await execStep(s, ctx); }));
      await Promise.race([all, sleep(4000)]);   // espera até 4 s para informar se alguma falhou
      const bad = results.filter((r): r is Result => r !== null && !r[0]);
      if (bad.length) return [false, tr('{k} de {n} falharam: {m}', { k: bad.length, n, m: tr(bad[0]![1]) })];
      return [true, tr('{n} ações ao mesmo tempo', { n })];
    }
    if (mode === 'cycle' || mode === 'random') {
      const key = ctx.btn ? ctx.btn.join(':') : '?';
      const k = mode === 'random' ? Math.floor(Math.random() * n) : (cycleState.get(key) ?? 0) % n;
      if (mode === 'cycle') cycleState.set(key, (k + 1) % n);
      const [ok, msg] = await execStep(steps[k]!, ctx);
      return [ok, ok ? tr('passo {k}/{n}', { k: k + 1, n }) : msg];
    }
    const keep = pyBool(a.keep);
    void (async () => {   // em sequência: segundo plano; para no primeiro erro (a menos que "continuar")
      for (const st of steps) {
        if (st.type === 'delay') { await sleep(Math.max(0, Math.min(10_000, pyInt(st.ms ?? 0) ?? 0))); continue; }
        const [ok, msg] = await execStep(st, ctx);
        if (!ok) { console.log(`[multi] passo ${st.type} falhou: ${msg}`); if (!keep) return; }
      }
    })();
    return [true, tr('{n} passos', { n })];
  },
  /** Ação de plugin (Ulanzi): o toque é entregue ao plugin; o texto do aviso, se ele mandar um toast, volta na mensagem. */
  async plugin(_a, ctx) {
    if (!hooks.pluginPress || !ctx.btn) return [false, 'plugins desativados'];
    return hooks.pluginPress(ctx.btn[0], ctx.btn[1]);
  },
  /** Monitor de Recursos: o botão mostra CPU/GPU/RAM ao vivo (desenhado em render.ts); tocar lê na hora e mostra os números na faixa da placa. */
  async resources() {
    const r = await readResources(), f = (v: number | null) => (v === null ? '--' : v + '%');
    return [true, `CPU ${f(r.cpu)} · GPU ${f(r.gpu)} · RAM ${r.ram.percent}%`];
  },
  /** Casa inteligente: webhook HTTP(S), Home Assistant e MQTT (netactions.ts). A placa também executa estes tipos sozinha no modo autônomo. */
  async webhook(a) { return runWebhook(a); },
  async homeassistant(a) { return runHomeAssistant(a); },
  async mqtt(a) { return runMqtt(a); },
  /** Relógio / Clima: botões que só mostram informação (desenhados em widgets.ts); tocar atualiza o clima na hora. */
  async widget(a, ctx) {
    if (a.kind === 'notifications') { openHistory(ctx.store); return [true, 'ok']; }   // abre o histórico (página temporária com rolagem)
    if (a.kind === 'nowplaying') { const r = await platform.media('playpause'); setTimeout(() => { void widgetRefresh('nowplaying'); }, 700); return r; }   // tocar no "Tocando agora" = play/pausa
    await widgetRefresh(String(a.kind), true); return [true, 'ok'];
  },
  /** Botões da página de histórico de notificações (notify.ts): rolar, limpar, dispensar. */
  async notif(a, ctx) { return notifPress(ctx.store, a); },
  /** Controle deslizante: o botão é arrastado na placa (POST /api/slide); tocar por outro caminho (teste na página) só avisa como usar. */
  async slider() { return [true, 'arraste o dedo no botão (na placa)']; },
  /** Navegação: próxima/anterior (em ciclo), início (1ª página), voltar (histórico) ou ir para uma página (pasta). */
  async page(a, ctx) {
    const { store } = ctx, op = a.op, ids = store.topPages().map((p) => p.id), cur = ids.indexOf(store.topOf(store.cfg.current));   // as subpastas não entram no próxima/anterior/início
    if (op === 'next') store.switchTo(ids[(cur + 1) % ids.length]!);
    else if (op === 'prev') store.switchTo(ids[(cur - 1 + ids.length) % ids.length]!);
    else if (op === 'home') store.switchTo(ids[0]!);
    else if (op === 'up') {   // botão "Voltar" das subpastas: sobe para a página de origem (ou para a 1ª página, se já estiver em uma de topo)
      const here = store.getPage(store.cfg.current);
      store.switchTo(here && here.parent !== undefined && store.getPage(here.parent) ? here.parent : ids[0]!, false);
    }
    else if (op === 'back') {
      let target = ids[0]!;
      while (store.history.length) { const h = store.history.pop()!; if (store.getPage(h) && h !== store.cfg.current) { target = h; break; } }
      store.switchTo(target, false);
    } else if (op === 'goto') {
      const target = pyInt(a.page);
      if (target === null) return [false, 'página inválida'];
      if (!store.getPage(target)) return [false, 'a página não existe mais'];
      store.switchTo(target);
    } else return [false, 'operação de página desconhecida'];
    return [true, 'ok'];
  },
};

export async function execStep(a: Action, ctx: Ctx): Promise<Result> {
  const fn = ACTIONS[a.type];
  if (!fn) return [false, `ação desconhecida: ${a.type}`];
  try { return await fn(a, ctx); } catch (e) { return [false, e instanceof Error ? e.message : String(e)]; }
}

/** Valida e normaliza uma ação vinda da página de configuração. Lança ValueError com mensagem para o usuário. */
export function cleanAction(act: unknown, nested = false): Action | null {
  if (act === null || act === undefined) return null;
  if (typeof act !== 'object' || Array.isArray(act)) throw new ValueError('ação inválida');
  const A = act as Record<string, any>, t = A.type;
  if (t === 'delay' && nested) {
    const ms = pyInt('ms' in A ? A.ms : 500);
    if (ms === null) throw new ValueError('tempo de espera inválido');
    return { type: 'delay', ms: Math.max(0, Math.min(10_000, ms)) };
  }
  if (typeof t !== 'string' || !(t in ACTIONS) || (t === 'multi' && nested)) throw new ValueError('ação inválida');
  const out: Action = { type: t };
  if (t === 'app' || t === 'quitapp') {
    out.app = slice(strip(pyStr('app' in A ? A.app : '')), 0, 200); out.path = slice(pyStr('path' in A ? A.path : ''), 0, 400);
    if (!out.app) throw new ValueError('escolha um aplicativo');
  } else if (t === 'folder') {   // a página da pasta é criada pelo servidor ao salvar o botão (server.ts)
    if (nested) throw new ValueError('uma subpasta não pode ser um passo de sequência');
    const p = 'page' in A ? pyInt(A.page) : null; if (p !== null) out.page = p;
  } else if (t === 'page') {
    if (!PAGE_OPS.includes(A.op) && A.op !== 'up') throw new ValueError('operação de página inválida');   // 'up' fica fora de PAGE_OPS (lista enviada à página, igual à do servidor Python)
    out.op = A.op;
    if (out.op === 'goto') { const p = pyInt(A.page); if (p === null) throw new ValueError('escolha a página de destino'); out.page = p; }
  } else if (t === 'url') {
    out.url = slice(strip(pyStr('url' in A ? A.url : '')), 0, 500);
    if (!out.url) throw new ValueError('digite o endereço do site');
  } else if (t === 'text') {
    out.text = slice(pyStr('text' in A ? A.text : ''), 0, 500); out.enter = pyBool(A.enter);
    if (!out.text) throw new ValueError('digite o texto');
  } else if (t === 'hotkey') out.keys = parseHotkey(A.keys)[2];
  else if (t === 'media') {
    if (typeof A.key !== 'string' || !(A.key in MEDIA_KEYS)) throw new ValueError('escolha a tecla de mídia');
    out.key = A.key;
  } else if (t === 'plugin') {   // atribuída pelo seletor de plugin da página; aqui só se valida o que já existe (o host confere plugin, ação e formato)
    if (nested) throw new ValueError('plugin não pode ser um passo de sequência');
    try { Object.assign(out, hooks.pluginValidate ? hooks.pluginValidate(A) : (() => { throw new Error('plugins desativados'); })()); } catch (e) { throw new ValueError(e instanceof Error ? e.message : String(e)); }
  } else if (t === 'webhook' || t === 'homeassistant' || t === 'mqtt') {
    if (nested) throw new ValueError('este tipo de ação não pode ser um passo de sequência');
    try { Object.assign(out, cleanNet(t, A)); } catch (e) { throw new ValueError(e instanceof Error ? e.message : String(e)); }
  } else if (t === 'widget') {
    if (nested) throw new ValueError('este tipo de ação não pode ser um passo de sequência');
    if (!(WIDGET_KINDS as readonly string[]).includes(A.kind)) throw new ValueError('escolha Relógio ou Clima');
    out.kind = A.kind;
  } else if (t === 'slider') {
    if (nested) throw new ValueError('o controle deslizante não pode ser um passo de sequência');
    if (!SLIDER_MODES.includes(A.mode)) throw new ValueError('escolha o que o controle deslizante controla');
    out.mode = A.mode;
    if (A.mode === 'appvolume') out.app = SLIDER_APPS.includes(A.app) ? A.app : 'spotify';
    if (A.axis === 'h' || A.axis === 'v') out.axis = A.axis;   // 'auto' (padrão) não é guardado
    if (A.mode === 'scrub') { out.dec = parseHotkey('dec' in A && A.dec ? A.dec : 'left')[2]; out.inc = parseHotkey('inc' in A && A.inc ? A.inc : 'right')[2]; }
    if (A.mode === 'brightness' || A.mode === 'scrub') { const n = pyInt('sens' in A ? A.sens : 24); out.sens = Math.max(4, Math.min(80, n ?? 24)); }
  } else if (t === 'resources') {
    if (nested) throw new ValueError('o monitor de recursos não pode ser um passo de sequência');
    out.res = RES_KINDS.includes(A.res) ? A.res : 'all';
    if (out.res === 'all' && (A.layout === 'line' || A.layout === 'rows')) out.layout = A.layout;   // 'auto' (padrão) não é guardado
  } else if (t === 'multi') {
    const steps = A.steps, mode = 'mode' in A ? A.mode : 'seq';
    if (typeof mode !== 'string' || !(mode in MULTI_MODES)) throw new ValueError('modo inválido');
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 12) throw new ValueError('a lista precisa de 1 a 12 passos');
    out.mode = mode; out.keep = pyBool(A.keep) && mode === 'seq';
    out.steps = steps.map((x) => cleanAction(x, true));
    if ((out.steps as (Action | null)[]).some((x) => x === null)) throw new ValueError('passo vazio');
    if (mode !== 'seq' && (out.steps as Action[]).some((x) => x.type === 'delay')) throw new ValueError('"esperar" só faz sentido no modo em sequência');
    if ((mode === 'cycle' || mode === 'random') && (out.steps as Action[]).length < 2) throw new ValueError('este modo precisa de pelo menos 2 passos');
  }
  return out;
}

/** Ações que não fazem sentido ao segurar o botão (precisam do toque ou do arrasto normal, ou cuidam do próprio botão). */
export const NO_HOLD = ['slider', 'folder', 'widget', 'resources'];
/** hold = o botão foi SEGURADO na placa: executa a ação alternativa, se o botão tiver uma; senão, a normal (segurar nunca fica pior que tocar). */
export async function runAction(store: Store, pid: number, i: number, hold = false): Promise<Result> {
  const b = store.getButton(pid, i);
  if (!b) return [false, 'botão inexistente'];
  const act = hold && b.alt ? b.alt : b.action;
  if (!act) return [false, 'botão sem ação'];
  const r = await execStep(act, { store, btn: [pid, i] }); hooks.stateKick?.(); return r;
}

const TOAST_OK: Record<string, string> = { webhook: 'enviado', homeassistant: 'enviado', mqtt: 'publicado', quitapp: 'fechado', app: 'aberto', url: 'aberto', text: 'digitado', hotkey: 'enviado', media: 'enviado', multi: 'iniciado' };
/** Texto curto que a placa mostra na faixa de baixo depois do toque. */
export function toastFor(store: Store, pid: number, i: number, ok: boolean, msg: string): string {
  const b = store.getButton(pid, i), name = slice(effectiveLabel(b!, (id) => store.getPage(id)?.name).split(/\s+/).filter(Boolean).join(' '), 0, 22), t = b?.action?.type ?? '';
  msg = tr(msg);
  if (t === 'slider') return ok ? `${name}: ${msg}` : slice(`${name}: ${msg}`, 0, 70);
  if (t === 'resources') return ok ? slice(msg, 0, 90) : slice(`${name}: ${msg}`, 0, 70);   // os números lidos valem por si
  if (t === 'plugin') return ok ? (msg && msg !== 'ok' ? slice(sanitizeGlyphs(msg), 0, 90) : `${name}: ok`) : slice(`${name}: ${msg}`, 0, 70);   // o toast do plugin vale por si (sem o nome na frente)
  if (ok && t === 'multi') return slice(`${name}: ${msg}`, 0, 70);   // o modo informa o que aconteceu ("passo 2/3", "4 ações ao mesmo tempo"...)
  return ok ? `${name}: ${tr(TOAST_OK[t] ?? 'ok')}` : slice(`${name}: ${msg}`, 0, 70);
}
