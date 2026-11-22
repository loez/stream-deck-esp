// SDK de plugins do Stream Deck ESP ("deck-plugin"). Um arquivo, sem dependências (WebSocket nativo do Node 24).
// Copie este arquivo para dentro do plugin (ex.: plugin/deck-plugin.mjs): o app não roda `npm install` ao importar plugins.
// Protocolo: docs/PROTOCOLO-PLUGIN.md (v2). Exemplo: docs/exemplo-plugin/ola-mundo.deckplugin.
//
//   import { Plugin } from './deck-plugin.mjs';
//   const plugin = new Plugin();                       // endereço/porta vêm dos argumentos do processo, o id do plugin.json
//   plugin.action('contador', {                        // nome curto (ou id completo) da ação, como no plugin.json
//     onAdd: (b) => b.set({ text: 'Toques\n0' }),
//     onPress: (b) => { b.state.n = (b.state.n || 0) + 1; b.set({ text: `Toques\n${b.state.n}` }); b.toast('ok'); },
//   });
import fs from 'node:fs';
import path from 'node:path';

const shortOf = (action) => String(action).split('.').pop();

/** Um botão que usa uma ação do plugin. `settings` = configuração salva dele; `state` = área livre sua (não persiste). */
export class Button {
  constructor(plugin, m) {
    this.plugin = plugin; this.id = m.id; this.action = m.action; this.key = m.key;
    this.settings = m.settings || {}; this.state = {}; this.active = true; this._v = { text: undefined, image: undefined };
  }
  /** Muda o que o botão mostra. { image: 'data:image/png;base64,...' | Buffer(PNG), imageFile: 'resources/x.png', gif: base64|Buffer, gifFile: 'resources/x.gif', text: 'Título\n42' | null } — o que você não passa continua como estava. */
  set(v = {}) {
    if ('text' in v) this._v.text = v.text;
    if ('image' in v || 'imageFile' in v || 'gif' in v || 'gifFile' in v) this._v.image = v;
    this._send();
  }
  _send() {
    const i = this._v.image || {}, img = {};
    if (i.gif) img.gif = Buffer.isBuffer(i.gif) ? i.gif.toString('base64') : i.gif;
    else if (i.gifFile) img.gifFile = i.gifFile;
    else if (i.imageFile) img.file = i.imageFile;
    else if (i.image) img.data = Buffer.isBuffer(i.image) ? 'data:image/png;base64,' + i.image.toString('base64') : i.image;
    else img.state = 0;   // sem ícone seu: o do plugin.json
    this.plugin._raw({ type: 'button.set', id: this.id, image: img, ...(this._v.text != null ? { text: String(this._v.text) } : {}) });
  }
  /** Aviso curto (aparece como resultado do toque). */
  toast(msg) { this.plugin._raw({ type: 'toast', message: String(msg) }); }
  /** Marca o botão como falho. */
  alert() { this.plugin._raw({ type: 'button.alert', id: this.id }); }
  /** Salva a configuração deste botão (persiste; chama onSettings aqui e na tela de configuração). */
  save(settings) { this.settings = settings; this.plugin._raw({ type: 'button.settings.save', id: this.id, settings }); }
  /** Manda uma mensagem à tela de configuração aberta deste botão. */
  sendToUI(payload) { this.plugin._raw({ type: 'ui.send', id: this.id, payload }); }
}

export class Plugin {
  /** opções: { id, address, port, dir }. Padrões: argv[2], argv[3] e o "id" do plugin.json da pasta atual. */
  constructor(o = {}) {
    this.id = o.id || o.uuid || JSON.parse(fs.readFileSync(path.join(o.dir || process.cwd(), 'plugin.json'), 'utf8')).id;
    const address = o.address || process.argv[2], port = o.port || process.argv[3];
    if (!address || !port) throw new Error('deck-plugin: endereço/porta do host ausentes (o app inicia o plugin com `node <arquivo> 127.0.0.1 <porta>`)');
    this.language = o.language || process.argv[4] || 'pt-BR';   // idioma do app ('pt-BR' | 'en'), fixo enquanto o plugin roda
    this.buttons = new Map();      // id -> Button
    this._actions = new Map();     // nome da ação (curto ou completo) -> tratadores
    this._global = [];             // promessas pendentes de getGlobal
    this.onClose = () => process.exit(0);   // o app caiu/fechou a conexão: o plugin sai junto
    this.onRaw = null;             // gancho de baixo nível: onRaw(mensagem do host), antes dos tratadores (usado pela camada de compatibilidade)
    this.ws = new WebSocket(`ws://${address}:${port}`);
    this.ready = new Promise((res) => { this.ws.onopen = () => { this._raw({ type: 'hello', protocol: 2, role: 'plugin', plugin: this.id }); res(); }; });
    this.ws.onclose = () => this.onClose();
    this.ws.onmessage = (ev) => this._onMessage(JSON.parse(String(ev.data)));
  }
  /** Registra o tratamento de uma ação (nome curto = o que vem depois do último ponto do id, ou o id completo). handlers: onAdd, onRemove, onPress, onDown, onUp, onSettings(b, settings), onActive(b, ativo), onMessage(b, payload). */
  action(name, handlers) { this._actions.set(name, handlers); return this; }
  /** Botões ativos (opcionalmente só de uma ação). */
  list(name) { return [...this.buttons.values()].filter((b) => !name || b.action === name || shortOf(b.action) === name); }
  /** Configuração global do plugin (persiste). */
  getGlobal() { return new Promise((res) => { this._global.push(res); this._raw({ type: 'global.get' }); }); }
  setGlobal(settings) { this._raw({ type: 'global.set', settings }); }
  /** Abre um endereço http/https no navegador do usuário. */
  openUrl(url, params) { this._raw({ type: 'open', url, ...(params ? { params } : {}) }); }
  /** Aperta um atalho de teclado no computador (ex.: 'cmd+shift+4'; "cmd" vira Ctrl fora do Mac). */
  hotkey(keys) { this._raw({ type: 'hotkey', keys }); }
  /** Escreve no log do plugin (tela de Plugins do app). */
  log(message, level = 'info') { this._raw({ type: 'log', level, message: String(message) }); }

  /** Envia uma mensagem do protocolo como está (uso avançado). */
  send(o) { this._raw(o); }
  _raw(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  _onMessage(m) {
    if (this.onRaw) { try { this.onRaw(m); } catch (e) { this.log(`onRaw: ${e?.stack || e}`, 'error'); } }
    if (m.type === 'global.settings') { const r = this._global.shift(); if (r) r(m.settings || {}); return; }
    if (m.type === 'button.add') { const b = new Button(this, m); this.buttons.set(b.id, b); this._call(b, 'onAdd'); return; }
    if (m.type === 'button.remove') { const b = this.buttons.get(m.id); if (b) { this.buttons.delete(b.id); this._call(b, 'onRemove'); } return; }
    const b = this.buttons.get(m.id); if (!b) return;
    switch (m.type) {
      case 'button.press': b.settings = m.settings || b.settings; this._call(b, 'onPress'); break;
      case 'button.down': this._call(b, 'onDown'); break;
      case 'button.up': this._call(b, 'onUp'); break;
      case 'button.active': b.active = m.active !== false; this._call(b, 'onActive', b.active); break;
      case 'button.settings': b.settings = m.settings || {}; this._call(b, 'onSettings', b.settings); break;
      case 'message': this._call(b, 'onMessage', m.payload); break;
    }
  }
  _call(b, fn, arg) {
    const h = this._actions.get(b.action) ?? this._actions.get(shortOf(b.action)); if (!h || typeof h[fn] !== 'function') return;
    try { const r = h[fn](b, arg); if (r && typeof r.catch === 'function') r.catch((e) => this.log(`${fn}: ${e?.stack || e}`, 'error')); }
    catch (e) { this.log(`${fn}: ${e?.stack || e}`, 'error'); }
  }
}
