// Procura a placa no cabo USB (Espressif, VID 303A) e mantém a ponte (usb.ts) aberta enquanto ela estiver lá. serialport é carregado só aqui, sob demanda:
// sem ele (ou sem permissão na porta) o app segue normal pelo Wi-Fi.
import fs from 'node:fs';
import path from 'node:path';
import { UsbSession, localRequest } from './usb.ts';
import type { Link } from './usb.ts';

export type UsbState = { enabled: boolean; state: 'off' | 'searching' | 'connected' | 'unavailable'; port: string | null; board: string | null; requests: number; error: string | null };
export type UsbBridge = { status(): UsbState; setEnabled(on: boolean): void; stop(): void };

/** Inicia a procura. `dataDir` guarda a preferência (liga/desliga) em usb.json. */
export function startUsbBridge(opts: { port: number; token: () => string; dataDir: string; log?: (m: string) => void }): UsbBridge {
  const log = opts.log ?? ((m) => console.log(m)), file = path.join(opts.dataDir, 'usb.json');
  let enabled = true; try { enabled = JSON.parse(fs.readFileSync(file, 'utf8')).enabled !== false; } catch { /* padrão: ligado */ }
  let session: UsbSession | null = null, portPath: string | null = null, stopped = false, busy = false, error: string | null = null, sp: any = null;
  const rejected = new Map<string, number>();   // porta que não é um deck: só tenta de novo depois de um tempo (ou quando ela some e volta)
  let seen = new Set<string>();

  const scan = async () => {
    if (stopped || busy || session) return;
    if (!enabled) return;
    busy = true;
    try {
      if (!sp) { try { sp = await import('serialport'); } catch (e) { error = 'módulo serialport indisponível'; return; } }
      const list: { path: string; vendorId?: string }[] = await sp.SerialPort.list();
      const mine = list.filter((p) => (p.vendorId ?? '').toLowerCase() === '303a');
      const now = Date.now(), here = new Set(mine.map((p) => p.path));
      for (const p of seen) if (!here.has(p)) rejected.delete(p);   // a porta sumiu: ao voltar, tenta de novo
      seen = here;
      for (const p of mine) {
        if ((rejected.get(p.path) ?? 0) > now) continue;
        if (await tryPort(p.path)) return;
        rejected.set(p.path, now + 60_000);
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  };
  const tryPort = async (p: string): Promise<boolean> => {
    const port: any = new sp.SerialPort({ path: p, baudRate: 115200, autoOpen: false, hupcl: false });   // hupcl:false: fechar a porta não derruba DTR/RTS (a placa não reinicia)
    const opened = await new Promise<boolean>((res) => port.open((e: Error | null) => { if (e) { error = e.message; res(false); } else res(true); }));
    if (!opened) return false;
    const s = new UsbSession(port as Link, localRequest(opts.port, opts.token()), log);
    const board = await s.probe(2500);
    if (!board) { s.onClose = null; s.end(); return false; }
    session = s; portPath = p; error = null;
    s.onClose = () => { log(`[usb] desconectado (${p})`); if (session === s) { session = null; portPath = null; } };
    s.start(); log(`[usb] placa "${board}" conectada por cabo em ${p}`);
    return true;
  };
  const timer = setInterval(() => { void scan(); }, 3000); timer.unref?.();
  setTimeout(() => { void scan(); }, 500).unref?.();
  return {
    status: () => ({ enabled, state: !enabled ? 'off' : session ? 'connected' : error === 'módulo serialport indisponível' ? 'unavailable' : 'searching', port: portPath, board: session?.board ?? null, requests: session?.requests ?? 0, error }),
    setEnabled(on) {
      enabled = on; try { fs.writeFileSync(file, JSON.stringify({ enabled: on })); } catch { /* sem gravar: vale só até reiniciar */ }
      if (!on && session) { const s = session; session = null; portPath = null; s.onClose = null; s.end(); log('[usb] desligado: porta liberada'); }
      else if (on) { rejected.clear(); void scan(); }
    },
    stop() { stopped = true; clearInterval(timer); if (session) { const s = session; session = null; s.onClose = null; s.end(); } },
  };
}
