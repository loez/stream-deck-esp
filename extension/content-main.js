// Roda no mundo da própria página: envolve Notification e showNotification para copiar o que o site mostra.
(() => {
  const send = (title, o) => { try { window.postMessage({ __deckNotify: 1, title: String(title ?? ''), body: String((o && o.body) ?? ''), tag: String((o && o.tag) ?? '') }, window.location.origin === 'null' ? '*' : window.location.origin); } catch { /* ignora */ } };
  const Native = window.Notification;
  if (Native) {
    const Wrapped = function Notification(title, options) { send(title, options); return new Native(title, options); };
    Wrapped.prototype = Native.prototype;
    Object.defineProperty(Wrapped, 'permission', { get: () => Native.permission });
    Wrapped.requestPermission = (...a) => Native.requestPermission(...a);
    Object.defineProperty(Wrapped, 'maxActions', { get: () => Native.maxActions });
    try { window.Notification = Wrapped; } catch { /* ignora */ }
  }
  const SW = window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype;
  if (SW && SW.showNotification) {
    const orig = SW.showNotification;
    SW.showNotification = function (title, options) { send(title, options); return orig.call(this, title, options); };
  }
})();
