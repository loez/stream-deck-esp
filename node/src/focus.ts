// Troca automática de página pelo app em foco (como o "perfil por aplicativo" do Ulanzi Studio): páginas podem ser vinculadas a apps;
// quando um deles vem para a frente, a placa mostra a página dele; ao ir para um app sem vínculo, volta à página que estava antes.
// O app da frente vem de platform.front() a cada 0,6 s (macOS: lsappinfo, sem permissão de Acessibilidade; Windows: GetForegroundWindow; Linux: xdotool, só X11).
import fs from 'node:fs';
import { FRONT_FILE } from './env.ts';
import { platform } from './platform/index.ts';
import type { Front } from './platform/index.ts';
import type { Store, Page } from './config.ts';

export type { Front } from './platform/index.ts';
/** App que está na frente agora (ou null se não deu para saber). */
export async function readFront(): Promise<Front | null> {
  if (FRONT_FILE) {
    try { const [bundle, name] = fs.readFileSync(FRONT_FILE, 'utf8').trim().split('|'); return bundle ? { bundle, name: name || bundle } : null; } catch { return null; }
  }
  return platform.front();
}

export class AutoSwitch {
  readonly store: Store;
  front: Front | null = null;
  auto: { on: boolean; base: number | null } = { on: false, base: null };   // on: a página atual foi escolhida pelo vínculo; base: a página de antes (para onde voltar)
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(store: Store) { this.store = store; }

  start(): void { this.timer = setInterval(() => void this.tick(), 600); void this.tick(); }
  stop(): void { clearInterval(this.timer); }
  private async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try { const f = await readFront(); if (f) this.onFront(f); } finally { this.busy = false; }
  }
  enabled(): boolean { return this.store.cfg.autoswitch !== false; }

  /** Página vinculada ao app (por bundle id; sem bundle, pelo nome). A primeira na ordem das páginas vence. */
  pageFor(f: Front): Page | undefined {
    return this.store.cfg.pages.find((pg) => pg.apps?.some((a) => (a.bundle ? a.bundle.toLowerCase() === f.bundle.toLowerCase() : a.name.toLowerCase() === f.name.toLowerCase())));
  }

  onFront(f: Front): void {
    if (platform.transient.has(f.bundle.toLowerCase())) return;
    const changed = this.front?.bundle !== f.bundle; this.front = f;
    if (changed && this.enabled()) this.apply(f);   // só age quando o app em foco MUDA: uma escolha manual de página vale até a próxima troca de app
  }
  private apply(f: Front): void {
    const target = this.pageFor(f);
    if (target) { if (!this.auto.on) this.auto = { on: true, base: this.store.cfg.current }; this.store.switchTo(target.id, false); }
    else if (this.auto.on) this.restore();
  }
  private restore(): void {
    const b = this.auto.base; this.auto = { on: false, base: null };
    this.store.switchTo(b !== null && this.store.getPage(b) ? b : this.store.cfg.pages[0]!.id, false);
  }
  /** Chamado ao ligar/desligar a troca automática ou editar os vínculos. */
  refresh(): void {
    if (!this.enabled()) { if (this.auto.on) this.restore(); return; }
    if (this.front) this.apply(this.front);
  }
  status(): { front: Front | null; enabled: boolean; on: boolean } { return { front: this.front, enabled: this.enabled(), on: this.auto.on }; }
}
