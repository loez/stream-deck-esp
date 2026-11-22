// Plugin "Bateria da Placa": mostra no botão o nível (%) da bateria da ESP32-S3 e controla a tela/energia da placa.
// Usa o SDK do projeto (deck-plugin.mjs, cópia de sdk; protocolo v2 em docs/PROTOCOLO-PLUGIN.md). SEM dependências.
// A placa informa a leitura do GPIO9 a cada poll (/api/deck?bmv=) e o servidor calcula a % em GET /api/status -> battery.
import { Plugin } from './deck-plugin.mjs';
const BASE = `http://127.0.0.1:${process.env.DECK_PORT || 8765}`, STATUS = BASE + '/api/status';
const plugin = new Plugin();
const EN = plugin.language.startsWith('en');   // idioma do app (fixo enquanto o plugin roda)
const T = (pt, en) => (EN ? en : pt);
let ultimo = undefined, tela = { pct: 100, off: false };   // ultimo: { percent, volts } | null (sem leitura) | undefined (ainda não consultou)

// Ícone SVG 144x144: bateria na horizontal preenchida até o %; verde > 30, amarelo 15-30, vermelho < 15; cinza sem leitura
function icone(bat) {
  const pc = bat ? bat.percent : null;
  const cor = pc === null ? '#6b7280' : pc < 15 ? '#ef4444' : pc <= 30 ? '#f59e0b' : '#22c55e';
  const fill = pc === null ? 0 : Math.max(pc > 0 ? 4 : 0, Math.round(92 * pc / 100));
  const txt = pc === null ? '--' : `${pc}%`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" rx="18" fill="#111827"/>
<rect x="18" y="26" width="102" height="52" rx="9" fill="none" stroke="#e5e7eb" stroke-width="5"/>
<rect x="122" y="42" width="8" height="20" rx="3" fill="#e5e7eb"/>
<rect x="25" y="33" width="${fill}" height="38" rx="4" fill="${cor}"/>
<text x="72" y="123" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#f9fafb" text-anchor="middle">${txt}</text>
</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

const svgUrl = (corpo) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="18" fill="#111827"/>${corpo}</svg>`).toString('base64');
const FONTE = 'font-family="Helvetica, Arial, sans-serif" font-weight="700" fill="#f9fafb" text-anchor="middle"';
function iconeTela(op) {
  if (op === 'poweroff') return svgUrl('<circle cx="72" cy="52" r="30" fill="none" stroke="#ef4444" stroke-width="7" stroke-dasharray="150 40" stroke-dashoffset="-26" stroke-linecap="round"/><line x1="72" y1="18" x2="72" y2="50" stroke="#ef4444" stroke-width="7" stroke-linecap="round"/>' + `<text x="72" y="128" font-size="22" ${FONTE}>desligar</text>`);   // sol com + / -, ou lua para apagar; nas de brilho mostra o % atual
  if (op === 'off') return svgUrl('<path d="M88 30a40 40 0 1 0 28 66A46 46 0 0 1 88 30z" fill="#e5e7eb"/>' + `<text x="72" y="128" font-size="22" ${FONTE}>apagar</text>`);
  const raios = Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4; return `<line x1="${72 + 34 * Math.cos(a)}" y1="${52 + 34 * Math.sin(a)}" x2="${72 + 44 * Math.cos(a)}" y2="${52 + 44 * Math.sin(a)}" stroke="#fbbf24" stroke-width="6" stroke-linecap="round"/>`; }).join('');
  const sinal = op === 'up' ? '<rect x="62" y="46" width="20" height="5" rx="2" fill="#111827"/><rect x="69.5" y="38.5" width="5" height="20" rx="2" fill="#111827"/>' : '<rect x="62" y="49.5" width="20" height="5" rx="2" fill="#111827"/>';
  return svgUrl(`${raios}<circle cx="72" cy="52" r="22" fill="#fbbf24"/>${sinal}<text x="72" y="122" font-size="34" ${FONTE}>${tela.off ? '--' : tela.pct + '%'}</text>`);
}


const OPS = { brilhomais: 'up', brilhomenos: 'down', apagar: 'off', desligar: 'poweroff' };   // ação -> op de POST /api/display

function desenhar(b) {
  const op = OPS[b.action.split('.').pop()];
  if (op) b.set({ image: iconeTela(op) });
  else b.set({ image: icone(ultimo), text: ultimo ? `${T('Bateria', 'Battery')} ${ultimo.percent}%\n${ultimo.volts.toFixed(2)} V` : T('Bateria\nsem leitura', 'Battery\nno reading') });
}
const desenharTodos = () => plugin.list().forEach(desenhar);

async function atualizar(toast) {
  try {
    const j = await (await fetch(STATUS, { signal: AbortSignal.timeout(3000) })).json();
    ultimo = j.connected ? (j.battery ?? null) : null;   // placa desconectada: o último valor ficaria velho
    if (j.display) tela = j.display;
  } catch { ultimo = null; }
  desenharTodos();   // reenviar o mesmo ícone não custa nada (o host compara)
  if (toast) plugin.list('nivel')[0]?.toast(ultimo ? `${T('Bateria', 'Battery')}: ${ultimo.percent}% (${ultimo.volts.toFixed(2)} V)` : T('Sem leitura da bateria', 'No battery reading'));
}

plugin.action('nivel', { onAdd: (b) => { desenhar(b); atualizar(false); }, onPress: () => atualizar(true) });
for (const nome of Object.keys(OPS)) plugin.action(nome, {
  onAdd: (b) => { desenhar(b); atualizar(false); },
  onPress: async (b) => {
    const op = OPS[nome];
    try {
      const j = await (await fetch(BASE + '/api/display', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op }), signal: AbortSignal.timeout(3000) })).json();
      if (op === 'poweroff') return b.toast(T('Placa desligando (RESET para voltar)', 'Powering off (press RESET to wake)'));
      tela = { pct: j.pct, off: j.off }; desenharTodos(); b.toast(j.off ? T('Tela apagada', 'Screen off') : `${T('Brilho', 'Brightness')}: ${j.pct}%`);
    } catch { b.toast(T('Servidor não respondeu', 'Server did not respond')); }
  },
});
setInterval(() => { if (plugin.list().length) atualizar(false); }, 5000);
