// Lê a serial da placa SEM reiniciá-la (hupcl:false, como o app) e envia comandos de depuração; --snap salva uma captura da tela (comando P) em PNG.
// pyserial reinicia a placa a cada open() (USB-Serial/JTAG): use este para observar o modo autônomo. Solte a porta do app antes (POST /api/usb {"enabled":false}).
// Uso: node tools/serial-sem-reiniciar.mjs <segundos> [--snap saida.png] [cmd ...]   (cmd: "T x,y" toque virtual, S estado, X apaga o perfil autônomo...)
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../node/package.json', import.meta.url));
const { SerialPort } = require('serialport'), { PNG } = require('pngjs');
const args = process.argv.slice(2), sec = Number(args.shift()); let snap = null; if (args[0] === '--snap') { args.shift(); snap = args.shift(); }
const list = await SerialPort.list(), p = list.find((x) => (x.vendorId ?? '').toLowerCase() === '303a'); if (!p) { console.log('sem porta'); process.exit(1); }
const port = new SerialPort({ path: p.path, baudRate: 115200, autoOpen: false, hupcl: false });
await new Promise((r, j) => port.open((e) => (e ? j(e) : r())));
let buf = Buffer.alloc(0); port.on('data', (d) => { buf = Buffer.concat([buf, d]); });
await new Promise((r) => setTimeout(r, 400));
for (const c of args) { port.write(c + '\n'); await new Promise((r) => setTimeout(r, 900)); }
if (snap) port.write('P\n');
const t0 = Date.now(); while (Date.now() - t0 < sec * 1000) { await new Promise((r) => setTimeout(r, 200)); if (snap && buf.includes('[snap-end]')) break; }
port.close();
const txt = buf.toString('latin1');
if (snap) {
  const m = /\[snap\] (\d+) (\d+) (\d+)\n/.exec(txt);
  if (!m) console.log('sem captura'); else {
    const w = +m[1], h = +m[2], n = +m[3], start = buf.indexOf(m[0]) + m[0].length, d = buf.subarray(start, start + n), png = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) { const v = d[2 * i] | (d[2 * i + 1] << 8); png.data[4 * i] = ((v >> 11) & 31) * 255 / 31; png.data[4 * i + 1] = ((v >> 5) & 63) * 255 / 63; png.data[4 * i + 2] = (v & 31) * 255 / 31; png.data[4 * i + 3] = 255; }
    fs.writeFileSync(snap, PNG.sync.write(png)); console.log('captura salva', w, h);
  }
}
console.log(buf.toString('utf8').replace(/\[snap\][\s\S]*?\[snap-end\]/, '[captura]').split('\n').filter((l) => /^\[(sa|exec|dbg|wifi|rede|usb|grade|estado|heap|placa|botao)/.test(l)).slice(-40).join('\n'));
console.log(/ESP-ROM/.test(txt) ? 'REINICIOU' : 'sem reinicio');
process.exit(0);
