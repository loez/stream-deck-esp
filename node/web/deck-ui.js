// SDK da tela de configuração de um plugin (navegador). Servido pelo app em /deck-ui.js; uso:
//   <script src="/deck-ui.js"></script>
//   const ui = new DeckUI();
//   ui.onSettings((s) => { /* preencha o formulário com a configuração do botão */ });
//   ui.onMessage((payload) => { /* mensagem do serviço do plugin (b.sendToUI) */ });
//   ui.save({ cor: 'azul' });          // grava a configuração do botão
//   ui.send({ type: 'teste' });        // manda uma mensagem ao serviço do plugin (onMessage do botão)
//   DeckUI.formValue(form) · DeckUI.setFormValue(valores, form) · DeckUI.debounce(fn, ms) · DeckUI.query('nome')
// Protocolo: docs/PROTOCOLO-PLUGIN.md. A página recebe na URL: port, address, id (do botão), plugin, action, key, language.
(function () {
  class DeckUI {
    constructor() {
      const q = new URLSearchParams(location.search);
      this.id = q.get('id'); this.plugin = q.get('plugin'); this.action = q.get('action'); this.key = q.get('key'); this.language = q.get('language') || 'pt_BR';   // 'pt_BR' | 'en' (idioma do app)
      this.settings = {}; this._set = []; this._msg = []; this._glob = [];
      this._loadedFlag = false;
      this.ready = new Promise((res) => { this._res = res; });
      this.ws = new WebSocket(`ws://${q.get('address') || '127.0.0.1'}:${q.get('port')}`);
      this.ws.onopen = () => this._send({ type: 'hello', protocol: 2, role: 'ui', id: this.id });
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'button.settings') { this.settings = m.settings || {}; this._loadedFlag = true; this._res(this.settings); this._set.forEach((f) => f(this.settings)); }
        else if (m.type === 'message') this._msg.forEach((f) => f(m.payload));
        else if (m.type === 'global.settings') { const r = this._glob.shift(); if (r) r(m.settings || {}); }
      };
    }
    _send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
    /** Chama fn com a configuração do botão agora (se já chegou) e sempre que ela mudar. */
    onSettings(fn) { this._set.push(fn); if (this._loaded()) fn(this.settings); return this; }
    _loaded() { return this._loadedFlag; }
    /** Mensagens do serviço do plugin para esta tela. */
    onMessage(fn) { this._msg.push(fn); return this; }
    save(settings) { this.settings = settings; this._send({ type: 'button.settings.save', settings }); }
    send(payload) { this._send({ type: 'plugin.send', payload }); }
    getGlobal() { return new Promise((res) => { this._glob.push(res); this._send({ type: 'global.get' }); }); }
    setGlobal(settings) { this._send({ type: 'global.set', settings }); }
  }
  // Utilitários de formulário (para telas que usam <form> com campos `name`)
  DeckUI.query = (name) => new URLSearchParams(location.search).get(name);
  /** Valores do formulário como objeto {name: valor}; nomes repetidos viram lista. */
  DeckUI.formValue = (form) => {
    if (typeof form === 'string') form = document.querySelector(form);
    const out = {};
    new FormData(form).forEach((v, k) => { if (!(k in out)) out[k] = v; else { if (!Array.isArray(out[k])) out[k] = [out[k]]; out[k].push(v); } });
    return out;
  };
  /** Preenche o formulário pelos nomes dos campos (checkbox/radio marcam se o valor bater). */
  DeckUI.setFormValue = (values, form) => {
    if (!values) return;
    if (typeof form === 'string') form = document.querySelector(form);
    Array.from(form.elements).filter((el) => el.name).forEach((el) => {
      const v = el.name in values ? values[el.name] : null; if (v === null) return;
      if (el.type === 'checkbox' || el.type === 'radio') { if (v === el.value || (Array.isArray(v) && v.includes(el.value))) el.checked = true; }
      else el.value = v ? v : '';
    });
  };
  /** Atrasa fn até `wait` ms sem novas chamadas (salvar enquanto digita). */
  DeckUI.debounce = (fn, wait = 150) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; };
  window.DeckUI = DeckUI;
})();
