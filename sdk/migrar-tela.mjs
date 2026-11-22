// LEGADO — migra a tela de configuração (HTML) de um plugin feito para o Ulanzi Studio para o nosso SDK de navegador (/deck-ui.js), trocando a biblioteca da Ulanzi (libs/js/ulanziApi.js e companhia).
// Uso: node sdk/migrar-tela.mjs <pasta-do-plugin> [--desfazer]
// Só edita a CÓPIA instalada no app (guarda <arquivo>.pre-deck-ui); depois de migrada, a tela não funciona mais no Ulanzi Studio. Se sobrar alguma chamada que o script não sabe trocar, NÃO grava nada e lista as linhas.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || ''), undo = process.argv.includes('--desfazer');
if (!process.argv[2] || !fs.existsSync(dir)) { console.error('uso: node sdk/migrar-tela.mjs <pasta-do-plugin> [--desfazer]'); process.exit(2); }
const htmls = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'libs', 'plugin-common-node'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.html?$/.test(e.name)) htmls.push(p); } })(dir);

let done = 0;
for (const f of htmls) {
  const bak = f + '.pre-deck-ui';
  if (undo) { if (fs.existsSync(bak)) { fs.copyFileSync(bak, f); fs.rmSync(bak); done++; console.log('restaurado:', path.relative(dir, f)); } continue; }
  let s = fs.readFileSync(f, 'utf8');
  if (!/libs\/js\/ulanziApi\.js/.test(s)) continue;   // não usa a biblioteca da Ulanzi
  const orig = s;
  // 1) as cinco bibliotecas viram o SDK do app; a instância `ui` nasce no começo do script da página
  s = s.replace(/(?:[ \t]*<script src="[^"]*libs\/js\/(?:constants|eventEmitter|timers|utils|ulanziApi)\.js"><\/script>\s*\n)+(\s*<script>)/, '  <script src="/deck-ui.js"></script>\n$1\n    const ui = new DeckUI();   // SDK da tela de configuração (migrado do SDK da Ulanzi; sdk/migrar-tela.mjs)');
  // 2) chamadas
  s = s.replace(/Utils\.getQueryParams\(/g, 'DeckUI.query(').replace(/Utils\.getFormValue\(/g, 'DeckUI.formValue(').replace(/Utils\.setFormValue\(/g, 'DeckUI.setFormValue(').replace(/Utils\.debounce\(/g, 'DeckUI.debounce(');
  s = s.replace(/\$UD\.uuid\b/g, 'ui.action').replace(/\$UD\.sendParamFromPlugin\(/g, 'ui.save(').replace(/\$UD\.sendToPlugin\(/g, 'ui.send(');
  s = s.replace(/^[ \t]*\$UD\.connect\(\);[ \t]*\n/gm, '');
  s = s.replace(/\$UD\.onConnected\(/g, 'ui.ready.then(');
  s = s.replace(/\$UD\.onSendToPropertyInspector\(\s*(?:function\s*\(\s*response\s*\)|\(\s*response\s*\)\s*=>)\s*\{/g, 'ui.onMessage(function(payload) { var response = { payload: payload };');
  s = s.replace(/\$UD\.on(?:Add|ParamFromApp)\(\s*(?:function\s*\(\s*msg\s*\)|\(\s*msg\s*\)\s*=>)\s*\{/g, 'ui.onSettings(function(param) { var msg = { uuid: ui.action, param: param };');
  const left = s.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\$UD\b|\bUtils\.|libs\/js\//.test(l));
  if (left.length) { console.log(`${path.relative(dir, f)}: sobrou algo que não sei trocar; nada gravado:`); for (const [n, l] of left) console.log(`  ${n}: ${l.trim().slice(0, 140)}`); process.exitCode = 1; continue; }
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, orig);
  fs.writeFileSync(f, s); done++; console.log('migrado:', path.relative(dir, f));
}
if (!done && !undo) console.log('nada a migrar: nenhuma tela usa a biblioteca da Ulanzi.');
