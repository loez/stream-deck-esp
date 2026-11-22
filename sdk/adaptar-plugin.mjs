// LEGADO — adapta um plugin feito para o Ulanzi Studio (que usa o pacote `plugin-common-node`) para rodar sobre o SDK do projeto.
// Uso: node sdk/adaptar-plugin.mjs <pasta-do-plugin> [--desfazer|--refazer]
// O que faz: copia deck-plugin.mjs e ulanzi-compat.mjs para <plugin>/deck-sdk/ e troca os imports de `plugin-common-node` por esse módulo (guarda <arquivo>.pre-deck-sdk).
// Não mexe na lógica do plugin nem nas telas de configuração (HTML). Plugins sem esse import (ex.: bundle próprio) são deixados como estão.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] || '');
const undo = process.argv.includes('--desfazer'), redo = process.argv.includes('--refazer');   // --refazer: volta ao original e adapta de novo (usar depois de atualizar o SDK)
if (!process.argv[2] || !fs.existsSync(path.join(dir, 'manifest.json'))) { console.error('uso: node sdk/adaptar-plugin.mjs <pasta-do-plugin com manifest.json> [--desfazer|--refazer]'); process.exit(2); }

const SKIP = new Set(['node_modules', 'plugin-common-node', 'property-inspector', 'pi', 'deck-sdk', '.git']);
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js)$/.test(e.name)) files.push(p); } })(dir);

if (undo || redo) {
  let n = 0;
  for (const f of files) { const bak = f + '.pre-deck-sdk'; if (fs.existsSync(bak)) { fs.copyFileSync(bak, f); fs.rmSync(bak); n++; } }
  fs.rmSync(path.join(dir, 'deck-sdk'), { recursive: true, force: true });
  console.log(`desfeito: ${n} arquivo(s) restaurado(s)`); if (!redo) process.exit(0);
}
const RE = /(from\s+)(['"])((?:\.\.?\/)+)plugin-common-node\/(?:index\.js|libs\/ulanziApi\.js)\2/g;
let changed = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!RE.test(src)) { RE.lastIndex = 0; continue; }
  RE.lastIndex = 0;
  const rel = path.relative(path.dirname(f), path.join(dir, 'deck-sdk', 'ulanzi-compat.mjs')).split(path.sep).join('/');
  const out = src.replace(RE, (_m, fromKw, q) => `${fromKw}${q}${rel.startsWith('.') ? rel : './' + rel}${q}`);
  if (!fs.existsSync(f + '.pre-deck-sdk')) fs.writeFileSync(f + '.pre-deck-sdk', src);
  fs.writeFileSync(f, out); changed++; console.log('adaptado:', path.relative(dir, f));
}
// Plugins empacotados (um .js minificado com o SDK da Ulanzi embutido, sem import para trocar): troca só a classe do cliente do host por uma que usa o nosso SDK.
// Cada remendo é preso ao texto exato do trecho original; se o plugin for de outra versão (texto diferente), nada é alterado.
const BUNDLE_PATCHES = [{
  name: 'cliente do host do SDK 2 da Ulanzi (Spotify)',
  start: 'We=class extends $t{websocket;host;port;uuid;',
  end: 'this.send(this.uuid,v.setState,{param:e})}};',
  // mesma interface do original (connect/send/setState/openUrl/showToast/setSettings/onConnected/onParam*, eventos `<uuid da ação>.<cmd>`), mas a conexão é do deck-sdk/deck-plugin.mjs
  keep: ['onConnected(e){', 'send(e,t,s={}){', 'openUrl(e,t=!1){', 'openView(e={}){', 'showToast(e){', 'setSettings(e){', 'onParamFromPlugin(e){', 'onParamFromApp(e){', 'setState(e={}){'],
  make: (orig) => {
    const from = orig.indexOf('onConnected(e){'), methods = orig.slice(from);
    const sendOld = 'send(e,t,s={}){if(this.websocket){let o={uuid:e,cmd:t,...s};j.info(this.uuid,"WEBSOCKET SEND",o),this.websocket.send(JSON.stringify(o))}}';
    if (!methods.includes(sendOld)) return null;
    const sendNew = 'send(e,t,s={}){if(this.deck){let o={uuid:e,cmd:t,...s};j.info(this.uuid,"WEBSOCKET SEND",o),this.deck.send(o)}}';
    const connect = 'We=class extends $t{websocket;host;port;uuid;deck;on=B.on;emit=B.emit;async connect(e,t,s){this.host=e,this.port=t,this.uuid=s;let{UlanziBridge:Br}=await import(require("url").pathToFileURL(require("path").join(__dirname,"..","deck-sdk","ulanzi-compat.mjs")).href),d=this.deck=new Br({uuid:s,address:e,port:t});'
      + 'd.onmessage=i=>{j.info(this.uuid,"WEBSOCKET MESSAGE",i);let{uuid:a,cmd:l}=i,c=a?`${a}.${l}`:l;c&&c!==""&&this.emit(c,i)},d.ready.then(()=>{j.info(this.uuid,"WEBSOCKET CONNECTED"),this.emit(v.connected,{uuid:this.uuid,port:this.port,websocket:d.deck.ws})})}';
    return connect + methods.replace(sendOld, sendNew);
  },
}];
for (const f of files) {
  let src = fs.readFileSync(f, 'utf8'); let out = src;
  for (const bp of BUNDLE_PATCHES) {
    const a = out.indexOf(bp.start); if (a < 0) continue;
    const b = out.indexOf(bp.end, a); if (b < 0) continue;
    const orig = out.slice(a, b + bp.end.length), neu = bp.make(orig);
    if (!neu) { console.log(`aviso: ${path.relative(dir, f)}: trecho de "${bp.name}" com formato inesperado; não alterado`); continue; }
    out = out.slice(0, a) + neu + out.slice(b + bp.end.length); console.log(`remendado: ${path.relative(dir, f)} (${bp.name})`);
  }
  if (out !== src) { if (!fs.existsSync(f + '.pre-deck-sdk')) fs.writeFileSync(f + '.pre-deck-sdk', src); fs.writeFileSync(f, out); changed++; }
}
if (!changed) { console.log('nada a adaptar: nenhum import de plugin-common-node (plugin já usa outro SDK ou um bundle próprio).'); process.exit(0); }
fs.mkdirSync(path.join(dir, 'deck-sdk'), { recursive: true });
for (const f of ['deck-plugin.mjs', 'ulanzi-compat.mjs']) fs.copyFileSync(path.join(SDK, f), path.join(dir, 'deck-sdk', f));
console.log(`pronto: ${changed} arquivo(s) usam o SDK do projeto (deck-sdk/). Reinicie o app para aplicar. Desfazer: node sdk/adaptar-plugin.mjs ${process.argv[2]} --desfazer`);
