// Extrator de .zip em JavaScript puro (sem depender de unzip/tar/PowerShell): métodos "stored" e "deflate", sem zip64 nem senha.
// Recusa entradas que escapariam da pasta de destino ("zip slip": ../ ou caminho absoluto) e arquivos grandes demais.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAX_TOTAL = 500 * 1024 * 1024;   // total descompactado

export function unzipTo(zipFile: string, dest: string): void {
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('não é um .zip válido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16), total = 0;
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('.zip corrompido');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new Error('.zip com senha não é suportado');
    const rel = name.replace(/\\/g, '/');
    if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) throw new Error('.zip com caminho inseguro');
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('.zip com caminho inseguro');
    if (rel.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    total += usize; if (total > MAX_TOTAL) throw new Error('.zip grande demais descompactado');
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('.zip corrompido');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) + 1024 }) : null;
    if (!data) throw new Error(`.zip com método de compressão ${method} não suportado`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}
