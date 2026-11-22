// Configuração (config.json): páginas, cada uma com N botões. "current" é a página mostrada na placa.
// Mesmo formato do servidor Python: {"rev","next_id","current","pages":[{"id","name","buttons":[{label,action,color,image,imgrev} x N]}]}
import fs from 'node:fs';
import { CFG_FILE, UPLOADS, DEFAULT_NAMES } from './env.ts';
import path from 'node:path';
import { setLang } from './i18n.ts';
import { randomInt } from 'node:crypto';
import { loadSettings, saveSettings, geometry, slotCount, slotOf, tileBox, STRIDE, MAX_SLOTS, MARGIN_X, GAP } from './settings.ts';
import type { Settings, Geom, Screen } from './settings.ts';
export { STRIDE, MAX_SLOTS };

// Cada página guarda os botões numa grade virtual de STRIDE colunas ("slot" = linha*STRIDE + coluna; 8 colunas) e tem pelo menos STRIDE*linhas slots.
// A grade escolhida (settings.ts) mostra só uma parte dela; o resto fica guardado, escondido, e volta se a grade crescer.
// Configurações antigas (4 colunas virtuais) são migradas ao carregar: cada botão mantém linha e coluna (só muda o número do slot); o original fica em config.json.bak-stride4.
/** Versão inicial das imagens dos botões (o campo "img" do /api/deck: a placa só baixa de novo quando ele MUDA, comparando por igualdade). Recomeçar do 1 a cada reinício
 *  do servidor fazia o valor novo coincidir com o que a placa já guardava, e ela ficava com a imagem antiga (ex.: "..."). Agora cada execução parte de um número aleatório
 *  (dentro de int32, que é o que a placa lê), então valores de execuções diferentes não se confundem. Modo legado = 1, como o servidor Python (paridade nos testes). */
const REV0 = DEFAULT_NAMES ? 1 : randomInt(1, 2 ** 30);
export const LABEL_MAX = 30, MAX_PAGES = 20, PAGE_NAME_MAX = 20;

export type Action = { type: string; [k: string]: any };
export type Button = { label: string; action: Action | null; alt?: Action | null;   // alt: ação ao SEGURAR o botão na placa
   color: string | null; image: string | null; imgrev: number; span?: { c: number; r: number } };   // span: botão juntado (ocupa c colunas x r linhas a partir deste slot); ausente = 1x1
/** Um botão como a placa o desenha: retângulo em pixels e índice da placa (linha*colunas + coluna) do canto superior esquerdo. */
export type Tile = { slot: number; i: number; c: number; r: number; x: number; y: number; w: number; h: number };
export type Page = { id: number; name: string; buttons: Button[]; apps?: { name: string; bundle: string }[];   // apps: a página aparece quando um deles está em foco
  parent?: number; autoBack?: boolean };   // parent: é uma SUBPASTA (página oculta, criada por um botão "Subpasta" da página parent); autoBack: depois de uma ação nela, volta à página de origem
export type Config = { rev: number; next_id: number; current: number; pages: Page[]; autoswitch?: boolean; stride?: number };   // stride: colunas da grade virtual (ausente = 4, formato antigo)   // autoswitch: false desliga a troca automática

export const emptyButton = (): Button => ({ label: '', action: null, color: null, image: null, imgrev: 1 });
export const newPage = (id: number, name: string, slots: number): Page => ({ id, name, buttons: Array.from({ length: slots }, emptyButton) });

/** Refaz o vetor de botões de uma página de `from` para `to` colunas virtuais, mantendo linha e coluna de cada botão. */
export function restride(buttons: Button[], from: number, to: number): Button[] {
  const rows = Math.ceil(buttons.length / from), out: Button[] = Array.from({ length: rows * to }, emptyButton);
  buttons.forEach((b, i) => { const r = Math.floor(i / from), c = i % from; if (c < to) out[r * to + c] = b; });
  return out;
}

function loadCfg(file: string, N: number): Config {
  try {
    let c: any = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!('pages' in c)) {   // formato antigo (uma página só): vira a página "Principal"
      const btns: Button[] = (c.buttons || []).slice(0, N);
      while (btns.length < N) btns.push(emptyButton());
      c = { rev: c.rev ?? 1, next_id: 2, current: 1, pages: [{ id: 1, name: 'Principal', buttons: btns }] };
    }
    const from = Number(c.stride) || 4;
    if (!DEFAULT_NAMES && from !== STRIDE) {   // migra a grade virtual de `from` para STRIDE colunas (cada botão mantém linha e coluna); guarda uma cópia da configuração original
      try { const bak = `${file}.bak-stride${from}`; if (!fs.existsSync(bak)) fs.copyFileSync(file, bak); } catch { /* sem cópia: segue */ }
      for (const pg of c.pages) pg.buttons = restride(pg.buttons, from, STRIDE);
    }
    if (!DEFAULT_NAMES) c.stride = STRIDE;
    for (const pg of c.pages) {
      while (pg.buttons.length < N) pg.buttons.push(emptyButton());
      pg.buttons = pg.buttons.slice(0, MAX_SLOTS);
    }
    if (!c.pages.some((pg: Page) => pg.id === c.current)) c.current = c.pages[0].id;
    return c as Config;
  } catch {
    return { rev: 1, next_id: 2, current: 1, pages: [newPage(1, 'Principal', N)], ...(DEFAULT_NAMES ? {} : { stride: STRIDE }) };   // config nova já nasce no formato atual (sem isso o próximo carregamento a migraria de novo)
  }
}

export class Store {
  cfg: Config;
  onSave: (() => void)[] = [];               // ouvintes: o host de plugins reconcilia atribuições e páginas ativas a cada mudança salva
  history: number[] = [];                    // páginas visitadas (ação "voltar"); só em memória
  viewRev: number[] = Array(MAX_SLOTS).fill(REV0);   // por slot: muda quando o que a placa deve mostrar naquele botão muda (troca de página ou edição da página atual)
  readonly file: string;
  settings: Settings; geom: Geom;            // grade e fonte escolhidas (settings.json, ao lado do config.json)
  constructor(file: string = CFG_FILE, settingsFile?: string) {
    this.file = file; this.settingsFile = settingsFile;
    this.settings = loadSettings(settingsFile); setLang(this.settings.lang); this.geom = geometry(this.settings);
    const before = fs.existsSync(file) ? Number((() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).stride; } catch { return 4; } })()) || 4 : STRIDE;
    this.cfg = loadCfg(file, slotCount(this.settings));
    if (!DEFAULT_NAMES && before !== STRIDE && fs.existsSync(file)) this.save();   // grava a configuração já migrada
  }
  private settingsFile?: string;
  /** Slots guardados por página (4 x linhas). */
  get slots(): number { return slotCount(this.settings); }
  /** Índice do botão na placa (linha*colunas + coluna) -> slot da página; null se fora da grade. */
  slotOfBoard(i: number): number | null { return Number.isInteger(i) && i >= 0 && i < this.geom.count ? slotOf(i, this.settings.cols) : null; }
  /** Muda a grade/fonte: guarda, completa as páginas com slots vazios e faz a placa reler tudo. */
  /** A placa informou o tamanho/densidade da tela (/api/deck?w=&h=&ppi=): se mudou, a geometria é recalculada e a placa relê tudo. */
  setScreen(sc: Screen): boolean {
    const cur = this.settings.screen;
    if (cur.w === sc.w && cur.h === sc.h && cur.ppi === sc.ppi) return false;
    this.setSettings({ ...this.settings, screen: sc }); return true;
  }
  setSettings(s: Settings): void {
    this.settings = s; setLang(s.lang); this.geom = geometry(s); saveSettings(s, this.settingsFile);
    for (const pg of this.cfg.pages) while (pg.buttons.length < this.slots) pg.buttons.push(emptyButton());
    this.bumpAll(); this.save();
  }

  save(): void {
    const tmp = this.file.replace(/\.json$/, '') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2));
    fs.renameSync(tmp, this.file);
    for (const f of this.onSave) { try { f(); } catch (e) { console.error('[onSave]', e); } }
  }
  getPage(pid: number): Page | undefined { return this.cfg.pages.find((p) => p.id === pid); }
  /** Tamanho (em células) do botão neste slot; 1x1 se não foi juntado ou o valor guardado é inválido. */
  spanOf(pid: number, slot: number): { c: number; r: number } {
    const s = this.getButton(pid, slot)?.span;
    return s && Number.isInteger(s.c) && Number.isInteger(s.r) && s.c >= 1 && s.r >= 1 && (s.c > 1 || s.r > 1) ? { c: s.c, r: s.r } : { c: 1, r: 1 };
  }
  /** Medidas (px, faixa do nome, texto) de um botão de c x r células. */
  tileBox(c: number, r: number): Geom { return tileBox(this.geom, c, r); }
  /** Botões da página como a placa os desenha. Um botão juntado só aparece inteiro dentro da grade visível; se não cabe, fica escondido e as células dele aparecem sozinhas.
   *  `useSpans = false`: cada célula é um botão 1x1 (firmware que não conhece botões juntados). */
  tiles(pid: number, useSpans = true): Tile[] {
    const pg = this.getPage(pid), g = this.geom, out: Tile[] = [], claimed: boolean[] = new Array(g.count).fill(false);
    if (!pg) return out;
    for (let k = 0; k < g.count; k++) {
      if (claimed[k]) continue;
      const col = k % g.cols, row = Math.floor(k / g.cols), slot = slotOf(k, g.cols);
      let { c, r } = useSpans ? this.spanOf(pid, slot) : { c: 1, r: 1 };
      if (c > 1 || r > 1) {
        if (col + c > g.cols || row + r > g.rows) { claimed[k] = true; continue; }   // não cabe na grade atual: escondido (guardado)
        let free = true; for (let rr = 0; rr < r; rr++) for (let cc = 0; cc < c; cc++) if (claimed[(row + rr) * g.cols + col + cc]) free = false;
        if (!free) { c = 1; r = 1; }   // cruza outro botão juntado (não deveria acontecer): mostra 1x1
      }
      for (let rr = 0; rr < r; rr++) for (let cc = 0; cc < c; cc++) claimed[(row + rr) * g.cols + col + cc] = true;
      const tb = tileBox(g, c, r);
      out.push({ slot, i: k, c, r, x: MARGIN_X + col * (g.w + GAP), y: g.top + row * (g.h + GAP), w: tb.w, h: tb.h });
    }
    return out;
  }
  /** Retângulo (em slots da grade virtual) ocupado por um botão c x r ancorado em `slot`. */
  rectSlots(slot: number, c: number, r: number): number[] {
    const col = slot % STRIDE, row = Math.floor(slot / STRIDE), out: number[] = [];
    for (let rr = 0; rr < r; rr++) for (let cc = 0; cc < c; cc++) out.push((row + rr) * STRIDE + col + cc);
    return out;
  }
  /** Junta c x r células a partir de `slot` num só botão. Devolve a mensagem de erro, ou null se deu certo. Só vale se TODAS as células (retângulo contínuo, então todas conectadas) estão vazias: sem ação, imagem, título nem cor. */
  merge(pid: number, slot: number, c: number, r: number): string | null {
    const pg = this.getPage(pid); if (!pg) return 'página inexistente';
    if (!Number.isInteger(slot) || slot < 0 || slot >= pg.buttons.length) return 'posição inválida';
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || r < 1 || (c === 1 && r === 1)) return 'tamanho inválido (para voltar a 1x1 use Separar)';
    const col = slot % STRIDE, row = Math.floor(slot / STRIDE);
    if (col + c > this.geom.cols || row + r > this.geom.rows) return 'não cabe na grade';   // a grade VISÍVEL (um botão que passa dela ficaria escondido)
    const mine = new Set(this.rectSlots(slot, c, r));
    for (let i = 0; i < pg.buttons.length; i++) {   // não pode cruzar outro botão juntado
      if (i === slot) continue; const sp = this.spanOf(pid, i); if (sp.c === 1 && sp.r === 1) continue;
      if (this.rectSlots(i, sp.c, sp.r).some((x) => mine.has(x))) return 'cruza outro botão juntado: separe-o primeiro';
    }
    const busy = this.rectSlots(slot, c, r).filter((x) => { const b = pg.buttons[x]!; return !!(b.action || b.image || (b.label && b.label.trim()) || b.color); });
    if (busy.length) return busy.length === 1 ? 'só dá para juntar botões vazios: um dos botões tem conteúdo (limpe-o primeiro)' : `só dá para juntar botões vazios: ${busy.length} dos botões têm conteúdo (limpe-os primeiro)`;
    pg.buttons[slot]!.span = { c, r }; return null;
  }
  unmerge(pid: number, slot: number): boolean {
    const b = this.getButton(pid, slot); if (!b || !b.span) return false; delete b.span; return true;
  }
  /** Páginas que aparecem como abas (as subpastas ficam ocultas). */
  topPages(): Page[] { return this.cfg.pages.filter((p) => p.parent === undefined); }
  /** A página de topo que contém esta (a própria, se não é subpasta). */
  topOf(pid: number): number { let pg = this.getPage(pid), n = 0; while (pg && pg.parent !== undefined && n++ < 20) pg = this.getPage(pg.parent); return pg ? pg.id : pid; }
  /** Apaga subpastas que nenhum botão "Subpasta" aponta mais (botão limpo, trocado ou página apagada), com as imagens enviadas delas. Retorna true se mudou algo. */
  gcFolders(): boolean {
    let changed = false;
    for (;;) {
      const used = new Set<number>();
      for (const pg of this.cfg.pages) for (const b of pg.buttons) if (b.action?.type === 'folder' && Number.isInteger(Number(b.action.page))) used.add(Number(b.action.page));
      const dead = this.cfg.pages.filter((p) => p.parent !== undefined && !used.has(p.id));
      if (!dead.length) return changed;
      for (const pg of dead) {
        for (const bb of pg.buttons) if (bb.image) fs.rmSync(path.join(UPLOADS, bb.image), { force: true });
        this.cfg.pages.splice(this.cfg.pages.indexOf(pg), 1); this.history = this.history.filter((h) => h !== pg.id);
        if (this.cfg.current === pg.id) { this.cfg.current = pg.parent !== undefined && this.getPage(pg.parent) ? pg.parent : this.cfg.pages[0]!.id; this.bumpAll(); }
      }
      changed = true;
    }
  }
  getButton(pid: number, i: number): Button | undefined {
    const pg = this.getPage(pid);
    return pg && i >= 0 && i < pg.buttons.length ? pg.buttons[i] : undefined;
  }
  /** Troca a configuração inteira (importação de backup): páginas completadas até o tamanho da grade, versões novas para a placa e a página redesenharem tudo. */
  replaceConfig(c: Config): void {
    c.rev = this.cfg.rev + 1; this.cfg = c; this.history = [];
    for (const pg of c.pages) while (pg.buttons.length < this.slots) pg.buttons.push(emptyButton());
    this.bumpAll(); this.save();
  }
  bumpAll(): void { for (let k = 0; k < MAX_SLOTS; k++) this.viewRev[k]!++; this.cfg.rev++; }
  /** Muda a página mostrada na placa (guarda o histórico para "voltar"). */
  switchTo(pid: number, push = true): void {
    if (pid === this.cfg.current || !this.getPage(pid)) return;
    if (push) { this.history.push(this.cfg.current); this.history.splice(0, Math.max(0, this.history.length - 20)); }
    this.cfg.current = pid; this.bumpAll(); this.save();
  }
}
