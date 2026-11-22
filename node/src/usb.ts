// Conexão da placa por USB (cabo): túnel HTTP sobre a porta serial (USB-Serial/JTAG do ESP32-S3).
// A placa faz os mesmos pedidos de sempre (GET /api/deck, GET /api/img/N.raw, POST /api/press/N...) só que em quadros binários pela serial; esta ponte repete cada pedido
// no próprio servidor (127.0.0.1, com o token do servidor: o cabo é o pareamento) e devolve a resposta. Toda a lógica (grade, imagens, ações) é a mesma do Wi-Fi.
// Protocolo (docs/PROTOCOLO-USB.md): quadro = A5 5A | tipo | id (u16 LE) | tamanho (u32 LE) | xor dos 8 bytes anteriores | payload. Os logs de texto da placa passam pela mesma porta e são ignorados.
import http from 'node:http';

export const T = { REQ: 1, RES: 2, HELLO: 3, BEACON: 4, PROBE: 7 } as const;   // REQ: placa -> servidor; RES: servidor -> placa; HELLO: servidor -> placa a cada 1 s (presença); PROBE/BEACON: "quem é você?"
export const HDR = 10, MAX_PAYLOAD = 8 * 1024 * 1024, PROTO = 1;
export type Frame = { type: number; id: number; payload: Buffer };

export function encodeFrame(type: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(HDR + payload.length);
  b[0] = 0xa5; b[1] = 0x5a; b[2] = type; b.writeUInt16LE(id & 0xffff, 3); b.writeUInt32LE(payload.length, 5);
  let x = 0; for (let i = 0; i < 9; i++) x ^= b[i]!; b[9] = x;   // 9 bytes: magia, tipo, id e tamanho
  payload.copy(b, HDR); return b;
}

/** Separa quadros de texto solto (logs da placa). Bytes que não formam um cabeçalho válido viram texto. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private onFrame: (f: Frame) => void; private onText: (t: Buffer) => void;
  constructor(onFrame: (f: Frame) => void, onText: (t: Buffer) => void = () => {}) { this.onFrame = onFrame; this.onText = onText; }
  feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      let i = -1;
      for (let k = 0; k + 1 < this.buf.length; k++) if (this.buf[k] === 0xa5 && this.buf[k + 1] === 0x5a) { i = k; break; }
      if (i < 0) {   // sem início de quadro: tudo é texto, menos um 0xA5 solto no fim (pode ser o começo de um)
        const keep = this.buf.length && this.buf[this.buf.length - 1] === 0xa5 ? 1 : 0;
        if (this.buf.length - keep > 0) this.onText(this.buf.subarray(0, this.buf.length - keep));
        this.buf = this.buf.subarray(this.buf.length - keep); return;
      }
      if (i > 0) { this.onText(this.buf.subarray(0, i)); this.buf = this.buf.subarray(i); }
      if (this.buf.length < HDR) return;
      let x = 0; for (let k = 0; k < 9; k++) x ^= this.buf[k]!;
      const len = this.buf.readUInt32LE(5);
      if (x !== this.buf[9] || len > MAX_PAYLOAD) { this.onText(this.buf.subarray(0, 1)); this.buf = this.buf.subarray(1); continue; }   // falso positivo
      if (this.buf.length < HDR + len) return;
      const f: Frame = { type: this.buf[2]!, id: this.buf.readUInt16LE(3), payload: Buffer.from(this.buf.subarray(HDR, HDR + len)) };
      this.buf = this.buf.subarray(HDR + len); this.onFrame(f);
    }
  }
}

/** O que a ponte precisa de uma porta aberta (o `SerialPort` do pacote serialport serve, e nos testes um Duplex). */
export interface Link {
  write(data: Buffer, cb?: (err?: Error | null) => void): boolean;
  on(ev: 'data', fn: (b: Buffer) => void): unknown;
  on(ev: 'close' | 'error', fn: (e?: Error) => void): unknown;
  once(ev: 'drain', fn: () => void): unknown;
  close?(cb?: () => void): void;
  destroy?(): void;
}
export type Handler = (method: 'GET' | 'POST', path: string) => Promise<{ status: number; body: Buffer }>;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Uma conversa com uma placa pelo cabo. */
export class UsbSession {
  board: string | null = null;   // preenchido quando a placa responde ao PROBE
  closed = false;
  onBoard: ((name: string) => void) | null = null;
  onClose: (() => void) | null = null;
  requests = 0;
  private tx: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private beacon: ((name: string) => void) | null = null;
  private link: Link; private handle: Handler; private log: (m: string) => void; private chunk: number; private pace: number;
  constructor(link: Link, handle: Handler, log: (m: string) => void = () => {}, chunk = 1024, pace = 1) {
    this.link = link; this.handle = handle; this.log = log; this.chunk = chunk; this.pace = pace;
    const parser = new FrameParser((f) => this.onFrame(f), (t) => { const s = t.toString('utf8').trim(); if (s && process.env.DECK_USB_LOG) this.log(`[placa] ${s.slice(0, 200)}`); });
    link.on('data', (b) => parser.feed(b));
    link.on('close', () => this.end());
    link.on('error', (e) => { this.log(`[usb] erro: ${e?.message ?? e}`); this.end(); });
  }
  /** Pergunta "quem é você?": resolve com o nome da placa, ou null se ninguém de um deck respondeu. */
  probe(timeoutMs = 2000): Promise<string | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.beacon = null; resolve(null); }, timeoutMs);
      this.beacon = (n) => { clearTimeout(t); this.beacon = null; resolve(n); };
      void this.send(T.PROBE, 0);
      // o PROBE pode ser perdido enquanto a placa ainda reinicia/abre a porta: repete uma vez
      setTimeout(() => { if (this.beacon) void this.send(T.PROBE, 0); }, Math.min(900, timeoutMs / 2));
    });
  }
  /** Passa a avisar a placa que o servidor está aqui (a cada 1 s): sem isso ela volta ao Wi-Fi. */
  start(): void {
    if (this.timer) return;
    const hello = () => { if (!this.closed) void this.send(T.HELLO, 0, Buffer.from([PROTO])); };
    hello(); this.timer = setInterval(hello, 1000); this.timer.unref?.();
  }
  end(): void {
    if (this.closed) return; this.closed = true;
    if (this.timer) clearInterval(this.timer);
    try { this.link.close ? this.link.close() : this.link.destroy?.(); } catch { /* já fechada */ }
    this.onClose?.();
  }
  /** Envia um quadro (em fila: um por vez) em pedaços pequenos, para a placa conseguir esvaziar o buffer da USB. */
  send(type: number, id: number, payload: Buffer = Buffer.alloc(0)): Promise<void> {
    const frame = encodeFrame(type, id, payload);
    this.tx = this.tx.then(async () => {
      for (let o = 0; o < frame.length && !this.closed; o += this.chunk) {
        const part = frame.subarray(o, Math.min(frame.length, o + this.chunk));
        const ok = await new Promise<boolean>((res) => { try { const flushed = this.link.write(part, (e) => { if (e) res(false); }); if (flushed) res(true); else this.link.once('drain', () => res(true)); } catch { res(false); } });
        if (!ok) { this.end(); return; }
        if (frame.length > this.chunk) await sleep(this.pace);
      }
    }).catch(() => {});
    return this.tx;
  }
  private onFrame(f: Frame): void {
    if (f.type === T.BEACON) { this.board = f.payload.toString('utf8').replace(/\0.*$/s, '') || 'deck'; this.beacon?.(this.board); this.onBoard?.(this.board); return; }
    if (f.type !== T.REQ || f.payload.length < 2) return;
    const method = f.payload[0] === 2 ? 'POST' : 'GET', p = f.payload.subarray(1).toString('utf8');
    if (!p.startsWith('/api/') || p.length > 400) { void this.reply(f.id, 400, Buffer.from('{"erro":"pedido inválido"}')); return; }
    this.requests++;
    this.handle(method, p).then((r) => this.reply(f.id, r.status, r.body), () => this.reply(f.id, 502, Buffer.from('{"erro":"falha no servidor"}')));
  }
  private reply(id: number, status: number, body: Buffer): Promise<void> {
    const head = Buffer.alloc(2); head.writeUInt16LE(status, 0);
    return this.send(T.RES, id, Buffer.concat([head, body]));
  }
}

/** Repete um pedido da placa no servidor local, no lugar da placa (token do servidor; o cabeçalho X-Deck-Via marca que veio do cabo). */
export function localRequest(port: number, token: string): Handler {
  return (method, path) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'X-Deck': token, 'X-Deck-Via': 'usb', 'Content-Length': '0' }, timeout: 15_000 }, (res) => {
      const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode ?? 502, body: Buffer.concat(ch) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 502, body: Buffer.from('{"erro":"servidor não respondeu"}') }));
    req.end();
  });
}
