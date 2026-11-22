// Gera os ícones do app (build/icon.icns, build/icon.png) e do menu de barra (build/trayTemplate.png + @2x) com o canvas do Skia. Uso: npm run icon
import { createCanvas } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
fs.mkdirSync(BUILD, { recursive: true });
const rr = (c, x, y, w, h, r) => { c.beginPath(); c.roundRect(x, y, w, h, r); };

// ícone do app: placa escura com uma grade 3x2 de botões coloridos
function appIcon(size) {
  const cv = createCanvas(size, size), c = cv.getContext('2d'), u = size / 1024;
  const m = 100 * u, body = size - 2 * m;
  const g = c.createLinearGradient(0, m, 0, size - m); g.addColorStop(0, '#34353c'); g.addColorStop(1, '#17181c');
  c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 28 * u; c.shadowOffsetY = 12 * u;
  c.fillStyle = g; rr(c, m, m, body, body, 190 * u); c.fill(); c.shadowColor = 'transparent';
  const cols = ['#19d9c8', '#ff7a45', '#6c7bff', '#35d07f', '#ffd166', '#ff5c8a'], pad = 112 * u, gap = 40 * u, tw = (body - 2 * pad - 2 * gap) / 3, th = (body - 2 * pad - gap) / 2;
  cols.forEach((col, i) => { const x = m + pad + (i % 3) * (tw + gap), y = m + pad + Math.floor(i / 3) * (th + gap); const tg = c.createLinearGradient(0, y, 0, y + th); tg.addColorStop(0, col); tg.addColorStop(1, col + 'aa'); c.fillStyle = tg; rr(c, x, y, tw, th, 52 * u); c.fill(); });
  return cv;
}
// ícone da barra de menu (modelo: só o canal alfa importa; o macOS pinta conforme o tema)
function trayIcon(px) {
  const cv = createCanvas(px, px), c = cv.getContext('2d'), u = px / 18; c.fillStyle = '#000';
  for (let i = 0; i < 6; i++) { const x = (1.5 + (i % 3) * 5.2) * u, y = (3.5 + Math.floor(i / 3) * 6) * u; rr(c, x, y, 4.2 * u, 5 * u, 1.2 * u); c.fill(); }
  return cv;
}
fs.writeFileSync(path.join(BUILD, 'trayTemplate.png'), trayIcon(18).toBuffer('image/png'));
fs.writeFileSync(path.join(BUILD, 'trayTemplate@2x.png'), trayIcon(36).toBuffer('image/png'));
fs.writeFileSync(path.join(BUILD, 'icon.png'), appIcon(1024).toBuffer('image/png'));
// icon.ico (Windows): PNGs embutidos (16 a 256 px), formato aceito desde o Windows Vista
const ico = (sizes) => {
  const pngs = sizes.map((s) => appIcon(s).toBuffer('image/png')), head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = 6 + 16 * sizes.length; const dir = sizes.map((s, i) => { const e = Buffer.alloc(16); e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(off, 12); off += pngs[i].length; return e; });
  return Buffer.concat([head, ...dir, ...pngs]);
};
fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
if (process.platform !== 'darwin') { console.log('ícones gerados em', BUILD, '(sem .icns: só o macOS tem o iconutil)'); process.exit(0); }
const set = path.join(BUILD, 'icon.iconset'); fs.rmSync(set, { recursive: true, force: true }); fs.mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) for (const k of [1, 2]) fs.writeFileSync(path.join(set, `icon_${s}x${s}${k === 2 ? '@2x' : ''}.png`), appIcon(s * k).toBuffer('image/png'));
execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(BUILD, 'icon.icns')]);
fs.rmSync(set, { recursive: true, force: true });
console.log('ícones gerados em', BUILD);
