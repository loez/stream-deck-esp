// LEGADO — só para plugins feitos para o Ulanzi Studio (nada do projeto depende disto).
// Traduz o protocolo antigo do Ulanzi (mensagens {cmd, uuid, key, actionid, ...}) para o nosso (v2) em cima do deck-plugin.mjs, de dois jeitos:
//   - `UlanziBridge`: mensagens no formato do Ulanzi <-> protocolo v2 (usado por plugins empacotados, como o Spotify);
//   - `UlanziApi`: a classe `UlanziApi` do pacote `plugin-common-node` do Ulanzi (connect/on*/set*Icon/toast/...), para o plugin trocar só o import.
// O script `adaptar-plugin.mjs` aplica isso a um plugin importado. Plugins do Ulanzi NÃO adaptados continuam funcionando: o app entende o protocolo antigo direto.
import EventEmitter from 'node:events';
import { Plugin } from './deck-plugin.mjs';

export const DEBUG_LOGS = process.env.ULANZI_DEBUG === '1';

/** Conexão "estilo Ulanzi" sobre o protocolo v2: `send(msg do Ulanzi)` e `onmessage(msg do Ulanzi)`. */
export class UlanziBridge {
  constructor({ uuid, address, port }) {
    this.uuid = uuid; this.onmessage = null; this.onclose = null;
    const deck = this.deck = new Plugin({ id: uuid, address, port });
    this.ready = deck.ready;
    deck.onClose = () => { if (this.onclose) this.onclose(); else process.exit(0); };
    deck.onRaw = (m) => this._in(m);
  }
  _emit(o) { if (this.onmessage) this.onmessage(o); }
  _in(m) {   // v2 -> Ulanzi
    const U = { uuid: m.action, key: m.key, actionid: m.id };
    switch (m.type) {
      case 'button.add': return this._emit({ cmd: 'add', ...U, param: m.settings });
      case 'button.remove': return this._emit({ cmd: 'clear', param: [U] });
      case 'button.active': return this._emit({ cmd: 'setactive', ...U, active: m.active });
      case 'button.down': return this._emit({ cmd: 'keydown', ...U });
      case 'button.press': return this._emit({ cmd: 'run', ...U, param: m.settings });
      case 'button.up': return this._emit({ cmd: 'keyup', ...U });
      case 'button.settings': this._emit({ cmd: 'paramfromapp', ...U, param: m.settings }); return this._emit({ cmd: 'didReceiveSettings', ...U, settings: m.settings });
      case 'message': return this._emit({ cmd: 'sendToPlugin', ...U, payload: m.payload });
      case 'global.settings': return this._emit({ cmd: 'didReceiveGlobalSettings', uuid: this.uuid, settings: m.settings });
    }
  }
  send(o) {   // Ulanzi -> v2
    const d = this.deck, id = o.actionid;
    switch (o.cmd) {
      case 'state': for (const it of o.param?.statelist ?? []) {
        const image = it.type === 1 ? { data: it.data } : it.type === 2 ? { file: it.path } : it.type === 3 ? { gif: it.gifdata } : it.type === 4 ? { gifFile: it.gifpath } : { state: Number(it.state ?? 0) || 0 };
        d.send({ type: 'button.set', id: it.actionid, image, ...(it.showtext ? { text: String(it.textData ?? '') } : {}) });
      } return;
      case 'toast': return d.send({ type: 'toast', message: String(o.msg ?? '') });
      case 'showAlert': return d.send({ type: 'button.alert', id });
      case 'logMessage': return d.log(o.message, o.level);
      case 'hotkey': return d.hotkey(o.keylist);
      case 'openurl': return d.send({ type: 'open', url: o.url, ...(o.param ? { params: o.param } : {}) });
      case 'getSettings': return d.send({ type: 'button.settings.get', id });
      case 'setSettings': return d.send({ type: 'button.settings.save', id, settings: o.settings });
      case 'paramfromplugin': return d.send({ type: 'button.settings.save', id, settings: o.param });
      case 'sendToPropertyInspector': return d.send({ type: 'ui.send', id, payload: o.payload });
      case 'getGlobalSettings': return d.send({ type: 'global.get' });
      case 'setGlobalSettings': return d.send({ type: 'global.set', settings: o.settings });
      default: return;   // eco {code:0}, setactive de confirmação, selectdialog, openview...: sem equivalente
    }
  }
}

const E = Object.freeze({ CONNECTED: 'connected', CLOSE: 'close', ERROR: 'error', ADD: 'add', RUN: 'run', PARAMFROMAPP: 'paramfromapp', PARAMFROMPLUGIN: 'paramfromplugin', SETACTIVE: 'setactive', CLEAR: 'clear',
  SELECTDIALOG: 'selectdialog', DIDRECEIVESETTINGS: 'didReceiveSettings', DIDRECEIVEGLOBALSETTINGS: 'didReceiveGlobalSettings', SENDTOPROPERTYINSPECTOR: 'sendToPropertyInspector', SENDTOPLUGIN: 'sendToPlugin',
  KEYDOWN: 'keydown', KEYUP: 'keyup', DIALDOWN: 'dialdown', DIALUP: 'dialup', DIALROTATE: 'dialrotate' });

/** A classe `UlanziApi` do `plugin-common-node`, com a mesma API, sobre o nosso SDK. Eventos com `context` (uuid___key___actionid). */
export default class UlanziApi extends EventEmitter {
  constructor() { super(); this.key = ''; this.uuid = ''; this.actionid = ''; this.language = 'en'; this.bridge = null; }

  /** Conecta ao host. Endereço/porta vêm dos argumentos do processo (como no original); o parâmetro `port` é só o padrão. */
  connect(uuid, port = 3906, address = '127.0.0.1') {
    this.uuid = uuid; this.address = process.argv[2] || address; this.port = process.argv[3] || port; this.language = process.argv[4] || 'en';
    const b = this.bridge = new UlanziBridge({ uuid, address: this.address, port: this.port });
    b.ready.then(() => this.emit(E.CONNECTED, {}));
    b.onclose = () => { if (this.listenerCount(E.CLOSE)) this.emit(E.CLOSE); else process.exit(0); };   // sem tratador, sai junto com o host
    b.onmessage = (data) => {
      if (!this.key && data.uuid === this.uuid && data.key) this.key = data.key;
      if (!this.actionid && data.uuid === this.uuid && data.actionid) this.actionid = data.actionid;
      if (data.cmd === 'clear') { for (const it of data.param || []) it.context = this.encodeContext(it); }
      else data.context = this.encodeContext(data);
      this.emit(data.cmd, data);
    };
  }
  t(key) { return key; }
  async localizeUI() {}
  encodeContext(j) { return `${j.uuid}___${j.key}___${j.actionid}`; }
  decodeContext(c) { const [uuid, key, actionid] = String(c).split('___'); return { uuid, key, actionid }; }
  send(cmd, params) { this.bridge?.send({ cmd, uuid: this.uuid, key: this.key, actionid: this.actionid, ...params }); }
  _ctx(context) { const c = context ? this.decodeContext(context) : {}; return { uuid: c.uuid || this.uuid, key: c.key || this.key, actionid: c.actionid || this.actionid }; }

  openUrl(url, local, param) { this.send('openurl', { url, local: !!local, param: param || null }); }
  openView() {}                                                                              // não suportado
  toast(msg) { this.send('toast', { msg }); }
  hotkey(key) { this.send('hotkey', { keylist: key }); }
  logMessage(msg, level) { this.send('logMessage', { message: msg, level: level || 'info' }); }
  sendParamFromPlugin(settings, context) { this.send('paramfromplugin', { ...this._ctx(context), param: settings }); }
  sendToPropertyInspector(settings, context) { const c = context ? this.decodeContext(context) : {}; this.send('sendToPropertyInspector', { uuid: c.uuid, key: c.key, actionid: c.actionid, payload: settings }); }
  sendToPlugin() {}                                                                          // só faz sentido na tela de configuração
  showAlert(context) { this.send('showAlert', this._ctx(context)); }
  getSettings(context) { this.send('getSettings', this._ctx(context)); }
  setSettings(settings, context) { this.send('setSettings', { ...this._ctx(context), settings }); }
  getGlobalSettings(context) { this.send('getGlobalSettings', this._ctx(context)); }
  setGlobalSettings(settings, context) { this.send('setGlobalSettings', { ...this._ctx(context), settings }); }
  selectFileDialog() {}                                                                      // não suportado
  selectFolderDialog() {}                                                                    // não suportado

  _state(context, f) { const { uuid, key, actionid } = this.decodeContext(context); const text = f.text; delete f.text; this.send('state', { param: { statelist: [{ uuid, key, actionid, ...f, textData: text || '', showtext: !!text }] } }); }
  setStateIcon(context, state, text) { this._state(context, { type: 0, state, text }); }
  setBaseDataIcon(context, data, text) { this._state(context, { type: 1, data, text }); }
  setPathIcon(context, path, text) { this._state(context, { type: 2, path, text }); }
  setGifDataIcon(context, gifdata, text) { this._state(context, { type: 3, gifdata, text }); }
  setGifPathIcon(context, gifpath, text) { this._state(context, { type: 4, gifpath, text }); }
}
// onXxx(fn): registra o tratador do evento e devolve a instância (encadeável), como no original
const ON = { onConnected: E.CONNECTED, onClose: E.CLOSE, onError: E.ERROR, onAdd: E.ADD, onParamFromApp: E.PARAMFROMAPP, onParamFromPlugin: E.PARAMFROMPLUGIN, onRun: E.RUN, onSetActive: E.SETACTIVE, onClear: E.CLEAR,
  onSelectdialog: E.SELECTDIALOG, onDidReceiveSettings: E.DIDRECEIVESETTINGS, onDidReceiveGlobalSettings: E.DIDRECEIVEGLOBALSETTINGS, onSendToPropertyInspector: E.SENDTOPROPERTYINSPECTOR, onSendToPlugin: E.SENDTOPLUGIN,
  onKeyDown: E.KEYDOWN, onKeyUp: E.KEYUP, onDialDown: E.DIALDOWN, onDialUp: E.DIALUP, onDialRotateLeft: E.DIALROTATE + 'left', onDialRotateRight: E.DIALROTATE + 'right', onDialRotateHoldLeft: E.DIALROTATE + 'holdleft', onDialRotateHoldRight: E.DIALROTATE + 'holdright', onDialRotate: E.DIALROTATE };
for (const [name, ev] of Object.entries(ON)) UlanziApi.prototype[name] = function (fn) { if (typeof fn !== 'function') throw new Error(`${name}: tratador obrigatório`); this.on(ev, (j) => fn(j)); return this; };   // dial: a placa não tem, nunca dispara
export { UlanziApi };
