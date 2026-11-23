const $ = (id) => document.getElementById(id);
chrome.storage.local.get(['port', 'key']).then((v) => { if (v.port) $('port').value = v.port; if (v.key) $('key').value = v.key; });
const save = () => chrome.storage.local.set({ port: Number($('port').value) || 8765, key: $('key').value.trim() });
$('save').onclick = async () => { await save(); $('m').textContent = 'Salvo.'; };
$('test').onclick = async () => { await save(); const r = await chrome.runtime.sendMessage({ type: 'test' }); $('m').textContent = r && r.ok ? 'Enviado: veja o botão Notificações da placa.' : `Falhou (${(r && (r.erro || r.status)) || '?'}). Confira a porta e a chave.`; };
