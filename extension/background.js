// Service worker: manda cada aviso ao servidor local (POST /api/notify) com a chave das opções. host_permissions dispensa o CORS.
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || (m.type !== 'notice' && m.type !== 'test')) return;
  (async () => {
    const { port = 8765, key = '' } = await chrome.storage.local.get(['port', 'key']);
    if (!key) return reply({ ok: false, erro: 'sem chave' });
    try {
      const r = await fetch(`http://127.0.0.1:${Number(port) || 8765}/api/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Deck-Notify': key },
        body: JSON.stringify(m.type === 'test' ? { source: 'extensão', title: 'Teste', body: 'Funcionou!' } : { source: m.source, title: m.title, body: m.body, tag: m.tag }),
      });
      reply({ ok: r.ok, status: r.status });
    } catch { reply({ ok: false, erro: 'servidor fora do ar' }); }
  })();
  return true;
});
