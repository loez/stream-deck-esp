// Protocolos de plugin do host (src/plugins.ts), em duas "línguas" que viram a MESMA coisa por dentro:
//   - "deck" (v2, a nossa; docs/PROTOCOLO-PLUGIN.md): mensagens {type, ...}; o botão é identificado só pelo `id` (o id da atribuição).
//   - "ulanzi" (legado, só para plugins do Ulanzi Studio): mensagens {cmd, uuid, key, actionid, ...}. Mantido por compatibilidade; nada do projeto depende dele.
// O host só conhece os eventos normalizados `In` (conexão -> host) e `Out` (host -> conexão); cada língua tem um decodificador e um codificador.

export type ImageSpec = { t: 'manifest'; index: number } | { t: 'data'; data: string } | { t: 'file'; path: string } | { t: 'gif'; data: string } | { t: 'gifFile'; path: string };
export type BtnRef = { id: string; action: string; key: string };   // id = id da atribuição; action = id da ação no manifest; key = "coluna_linha"

/** Conexão -> host. */
export type In =
  | { k: 'image'; id: string; image: ImageSpec; text: string }                 // o que o botão mostra (estado completo)
  | { k: 'toast'; message: string } | { k: 'alert'; id: string }
  | { k: 'log'; level: string; message: string }
  | { k: 'hotkey'; keys: string } | { k: 'open'; url: string; params?: Record<string, string>; local: boolean }
  | { k: 'settings.get'; id: string }
  | { k: 'settings.save'; id: string; settings: unknown; forward: boolean }     // forward: só o legado (a outra ponta recebe como "paramfromapp")
  | { k: 'to.plugin'; id: string; payload: unknown }                            // tela de configuração -> serviço do plugin
  | { k: 'to.ui'; id: string; payload: unknown }                                // serviço do plugin -> tela de configuração
  | { k: 'global.get'; action?: string } | { k: 'global.set'; settings: unknown; action?: string }
  | { k: 'unsupported'; what: string }
  | { k: 'echo' };                                                              // confirmação do legado: ignorar

/** Host -> conexão. */
export type Out =
  | { k: 'add'; a: BtnRef; settings: Record<string, any> }
  | { k: 'remove'; list: BtnRef[] }
  | { k: 'active'; a: BtnRef; active: boolean }
  | { k: 'press'; a: BtnRef; settings: Record<string, any> }
  | { k: 'settings'; a: BtnRef; settings: Record<string, any>; via: 'save' | 'forward' }
  | { k: 'ui.init'; a: BtnRef; settings: Record<string, any> }                  // abertura da tela de configuração
  | { k: 'from.ui'; a: BtnRef; payload: unknown }                               // mensagem da tela para o serviço
  | { k: 'from.plugin'; a: BtnRef; payload: unknown }                           // mensagem do serviço para a tela
  | { k: 'global'; id: string; settings: Record<string, any>; to?: string };   // to: só o legado (uuid que a tela espera no retorno)

export type Proto = 'deck' | 'ulanzi';

// ---------------- v2 (deck) ----------------
export function decodeDeck(m: any): In | null {
  const s = (x: unknown) => String(x ?? '');
  switch (m?.type) {
    case 'button.set': {
      const i = m.image ?? {}; let image: ImageSpec;
      if (typeof i.gif === 'string') image = { t: 'gif', data: i.gif };
      else if (typeof i.gifFile === 'string') image = { t: 'gifFile', path: i.gifFile };
      else if (typeof i.file === 'string') image = { t: 'file', path: i.file };
      else if (typeof i.data === 'string') image = { t: 'data', data: i.data };
      else image = { t: 'manifest', index: Number(i.state ?? 0) || 0 };
      return { k: 'image', id: s(m.id), image, text: m.text == null ? '' : s(m.text) };
    }
    case 'toast': return { k: 'toast', message: s(m.message) };
    case 'button.alert': return { k: 'alert', id: s(m.id) };
    case 'log': return { k: 'log', level: s(m.level || 'info'), message: s(m.message) };
    case 'hotkey': return { k: 'hotkey', keys: s(m.keys) };
    case 'open': return { k: 'open', url: s(m.url), params: m.params, local: false };
    case 'button.settings.get': return { k: 'settings.get', id: s(m.id) };
    case 'button.settings.save': return { k: 'settings.save', id: s(m.id), settings: m.settings, forward: false };
    case 'ui.send': return { k: 'to.ui', id: s(m.id), payload: m.payload };           // do serviço para a tela
    case 'plugin.send': return { k: 'to.plugin', id: s(m.id), payload: m.payload };   // da tela para o serviço
    case 'global.get': return { k: 'global.get' };
    case 'global.set': return { k: 'global.set', settings: m.settings };
    default: return null;
  }
}
const D = (a: BtnRef) => ({ id: a.id, action: a.action, key: a.key });
export function encodeDeck(o: Out): object[] {
  switch (o.k) {
    case 'add': return [{ type: 'button.add', ...D(o.a), settings: o.settings }];
    case 'remove': return o.list.map((a) => ({ type: 'button.remove', ...D(a) }));
    case 'active': return [{ type: 'button.active', ...D(o.a), active: o.active }];
    case 'press': return [{ type: 'button.down', ...D(o.a) }, { type: 'button.press', ...D(o.a), settings: o.settings }, { type: 'button.up', ...D(o.a) }];
    case 'settings': case 'ui.init': return [{ type: 'button.settings', ...D(o.a), settings: o.settings }];
    case 'from.ui': case 'from.plugin': return [{ type: 'message', ...D(o.a), payload: o.payload }];
    case 'global': return [{ type: 'global.settings', settings: o.settings }];
  }
}

// ---------------- legado (Ulanzi Studio) ----------------
export function decodeUlanzi(m: any): In[] {
  const s = (x: unknown) => String(x ?? '');
  const id = s(m?.actionid);
  switch (m?.cmd) {
    case 'state': return (m.param?.statelist ?? []).map((it: any): In => {
      let image: ImageSpec;
      if (it.type === 1) image = { t: 'data', data: s(it.data) };
      else if (it.type === 2) image = { t: 'file', path: s(it.path) };
      else if (it.type === 3) image = { t: 'gif', data: s(it.gifdata) };
      else if (it.type === 4) image = { t: 'gifFile', path: s(it.gifpath) };
      else image = { t: 'manifest', index: Number(it.state ?? 0) || 0 };
      return { k: 'image', id: s(it.actionid), image, text: it.showtext ? s(it.textData) : '' };
    });
    case 'toast': return [{ k: 'toast', message: s(m.msg) }];
    case 'showAlert': return [{ k: 'alert', id }];
    case 'logMessage': return [{ k: 'log', level: s(m.level), message: s(m.message) }];
    case 'hotkey': return [{ k: 'hotkey', keys: s(m.keylist) }];
    case 'openurl': return [{ k: 'open', url: s(m.url), params: m.param, local: !!m.local }];
    case 'getSettings': return [{ k: 'settings.get', id }];
    case 'setSettings': return [{ k: 'settings.save', id, settings: m.settings ?? m.param, forward: false }];
    case 'paramfromplugin': return [{ k: 'settings.save', id, settings: m.param, forward: true }];
    case 'sendToPlugin': return [{ k: 'to.plugin', id, payload: m.payload }];
    case 'sendToPropertyInspector': return [{ k: 'to.ui', id, payload: m.payload }];
    case 'getGlobalSettings': return [{ k: 'global.get', action: s(m.uuid) }];
    case 'setGlobalSettings': return [{ k: 'global.set', settings: m.settings ?? {}, action: s(m.uuid) }];
    case 'selectdialog': case 'openview': return [{ k: 'unsupported', what: s(m.cmd) }];
    default: return [{ k: 'unsupported', what: s(m?.cmd) }];
  }
}
const U = (a: BtnRef) => ({ uuid: a.action, key: a.key, actionid: a.id });
export function encodeUlanzi(o: Out): object[] {
  switch (o.k) {
    case 'add': return [{ cmd: 'add', ...U(o.a), param: o.settings }];
    case 'remove': return [{ cmd: 'clear', param: o.list.map(U) }];
    case 'active': return [{ cmd: 'setactive', ...U(o.a), active: o.active }];
    case 'press': return [{ cmd: 'keydown', ...U(o.a) }, { cmd: 'run', ...U(o.a), param: o.settings }, { cmd: 'keyup', ...U(o.a) }];
    case 'settings': return o.via === 'save' ? [{ cmd: 'didReceiveSettings', ...U(o.a), settings: o.settings }] : [{ cmd: 'paramfromapp', ...U(o.a), param: o.settings }];
    case 'ui.init': return [{ cmd: 'add', ...U(o.a), param: o.settings }, { cmd: 'paramfromapp', ...U(o.a), param: o.settings }];
    case 'from.ui': return [{ cmd: 'sendToPlugin', ...U(o.a), payload: o.payload }];
    case 'from.plugin': return [{ cmd: 'sendToPropertyInspector', ...U(o.a), payload: o.payload }];
    case 'global': return [{ cmd: 'didReceiveGlobalSettings', uuid: o.to ?? o.id, settings: o.settings }];
  }
}
