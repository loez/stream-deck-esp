// Mundo isolado da extensão: recebe o que content-main.js copiou e repassa ao service worker (só mensagens da própria janela).
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__deckNotify !== 1) return;
  try { chrome.runtime.sendMessage({ type: 'notice', title: e.data.title, body: e.data.body, tag: e.data.tag, source: location.hostname }); } catch { /* extensão recarregada */ }
});
