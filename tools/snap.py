#!/usr/bin/env python3
"""Captura a tela do painel por serial e salva PNG.  Uso: snap.py saida.png [comandos-antes ...]
Ex.: snap.py inicio.png        |  snap.py detalhe.png d0   (abre o detalhe da entidade 0 antes de capturar)
Atenção: abrir a porta REINICIA a placa; o script espera o boot (~12 s) e a conexão com o HA."""
import serial, sys, time, glob, re
from PIL import Image
out = sys.argv[1]; pre = sys.argv[2:]
port = glob.glob('/dev/cu.usbmodem*')[0]
s = serial.Serial(); s.port = port; s.baudrate = 115200; s.timeout = 0.3; s.dtr = False; s.rts = False; s.open()
def drena(t):
    end = time.time() + t
    while time.time() < end: s.read(4096)
drena(float(__import__('os').environ.get('BOOT_S', '14')))
for c in pre:
    s.write((c + '\n').encode()); drena(1.2)
s.write(b'P\n'); buf = b''; t0 = time.time()
while time.time() - t0 < 12 and b'[snap-end]' not in buf: buf += s.read(65536)
m = re.search(rb'\[snap\] (\d+) (\d+) (\d+)\n', buf)
if not m: sys.exit('sem captura: ' + buf[-200:].decode(errors='replace'))
w, h, n = map(int, m.groups()); data = buf[m.end():m.end() + n]
if len(data) < n: sys.exit(f'captura incompleta {len(data)}/{n}')
px = bytearray(w * h * 3)
for i in range(w * h):
    v = data[2 * i] | (data[2 * i + 1] << 8)
    px[3 * i] = ((v >> 11) & 31) * 255 // 31; px[3 * i + 1] = ((v >> 5) & 63) * 255 // 63; px[3 * i + 2] = (v & 31) * 255 // 31
Image.frombytes('RGB', (w, h), bytes(px)).resize((w * 2, h * 2), Image.NEAREST).save(out)
print('ok', out, w, h)
