// Notificações do navegador (extensão do Chrome em extension/): fila em memória, botão "Notificações" (widget) e a página temporária de histórico com rolagem.
// A extensão manda cada notificação para POST /api/notify (server.ts); o histórico é uma página oculta (`tmp`: nunca vai para o config.json) montada com botões `notif`.
import { createCanvas } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { newPage, emptyButton } from './config.ts';
import type { Store, Action } from './config.ts';
import { tr } from './i18n.ts';

export type Notice = { id: number; ts: number; source: string; title: string; body: string; tag: string; read: boolean };
export const NOTIF_MAX = 50, NOTIF_PAGE_ID = 900001;
const items: Notice[] = [];   // mais recente primeiro
let nextId = 1, offset = 0, stamps: number[] = [];
let onChange: () => void = () => {};
export const setNotifListener = (fn: () => void) => { onChange = fn; };

const clean = (s: unknown, max: number) => [...String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');

/** Entrada da extensão. Devolve null se descartada (limite de 30 por minuto, ou vazia). A mesma `tag` do mesmo site substitui a anterior (ex.: "3 novos e-mails"). */
export function pushNotice(raw: { source?: unknown; title?: unknown; body?: unknown; tag?: unknown }): Notice | null {
  const t = Date.now(); stamps = stamps.filter((x) => t - x < 60_000);
  const title = clean(raw.title, 120), body = clean(raw.body, 400), source = clean(raw.source, 60), tag = clean(raw.tag, 80);
  if ((!title && !body) || stamps.length >= 30) return null;
  stamps.push(t);
  if (tag) { const k = items.findIndex((n) => n.tag === tag && n.source === source); if (k >= 0) items.splice(k, 1); }
  const n: Notice = { id: nextId++, ts: t, source, title, body, tag, read: false };
  items.unshift(n); items.length = Math.min(items.length, NOTIF_MAX);
  onChange(); return n;
}
export const listNotices = (): Notice[] => items.slice();
export const unreadCount = (): number => items.filter((n) => !n.read).length;
export function dismissNotice(id: number): boolean { const k = items.findIndex((n) => n.id === id); if (k < 0) return false; items.splice(k, 1); clampOffset(); onChange(); return true; }
export function clearNotices(): void { items.length = 0; offset = 0; onChange(); }
export function markAllRead(): void { let ch = false; for (const n of items) if (!n.read) { n.read = true; ch = true; } if (ch) onChange(); }
/** Muda a cada novidade: serve de versão do botão. */
export const notifKey = (): string => `${items[0]?.id ?? 0}|${unreadCount()}|${items.length}`;
/** Só para testes. */
export function resetNotices(): void { items.length = 0; nextId = 1; offset = 0; stamps = []; }

// ---------- página de histórico ----------
/** Quantas mensagens cabem na página de histórico (4 botões fixos: Voltar, ▲, ▼, Limpar). */
const perPage = (store: Store): number => Math.max(1, store.geom.count - 4);
function clampOffset(): void { offset = Math.max(0, Math.min(offset, Math.max(0, items.length - 1))); }
export const historyOffset = (): number => offset;
const btn = (label: string, action: Action) => ({ label, action, color: null, image: null, imgrev: 1 });

/** Abre (ou recria) a página temporária de histórico, filha da página atual, e a mostra na placa. */
export function openHistory(store: Store): void {
  if (store.cfg.current === NOTIF_PAGE_ID) return;
  const from = store.cfg.current;
  let pg = store.getPage(NOTIF_PAGE_ID);
  if (!pg) { pg = newPage(NOTIF_PAGE_ID, tr('Notificações'), store.slots); pg.tmp = true; store.cfg.pages.push(pg); }
  pg.name = tr('Notificações'); pg.parent = from;
  for (let k = 0; k < pg.buttons.length; k++) pg.buttons[k] = emptyButton();
  for (let k = 0; k < store.geom.count; k++) {
    const slot = store.slotOfBoard(k)!;
    pg.buttons[slot] = k === 0 ? btn(tr('Voltar'), { type: 'page', op: 'up' }) : k === 1 ? btn('', { type: 'notif', op: 'up' }) : k === 2 ? btn('', { type: 'notif', op: 'down' }) : k === 3 ? btn('', { type: 'notif', op: 'clear' }) : btn('', { type: 'notif', op: 'item', n: k - 4 });
  }
  offset = 0; markAllRead(); store.switchTo(NOTIF_PAGE_ID, false);
}
/** Toque num botão `notif` da página de histórico. */
export function notifPress(store: Store, a: Record<string, any>): [boolean, string] {
  const step = perPage(store), op = String(a.op);
  if (op === 'up') offset = Math.max(0, offset - step);
  else if (op === 'down') offset = Math.min(Math.max(0, items.length - 1), offset + step < items.length ? offset + step : offset);
  else if (op === 'clear') { clearNotices(); return [true, 'ok']; }
  else if (op === 'item') { const n = items[offset + Number(a.n)]; if (!n) return [true, 'ok']; dismissNotice(n.id); return [true, 'ok']; }
  else return [false, 'operação desconhecida'];
  onChange(); return [true, 'ok'];
}

// ---------- desenho ----------
const font = (px: number) => `bold ${Math.max(7, Math.round(px))}px MontserratDeck`;
function wrap(o: ReturnType<Canvas['getContext']>, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(' '), lines: string[] = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (o.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines) { let last = lines[maxLines - 1]!; const used = words.join(' ') !== lines.join(' '); if (used || o.measureText(last).width > maxW) { while (last.length > 1 && o.measureText(last + '…').width > maxW) last = last.slice(0, -1); lines[maxLines - 1] = last + (used ? '…' : ''); } }
  return lines;
}
function bell(o: ReturnType<Canvas['getContext']>, cx: number, cy: number, s: number, color: string): void {
  o.fillStyle = color; o.beginPath(); o.moveTo(cx - s, cy + s * 0.55); o.quadraticCurveTo(cx - s, cy - s * 0.1, cx - s * 0.6, cy - s * 0.55); o.quadraticCurveTo(cx, cy - s * 1.35, cx + s * 0.6, cy - s * 0.55); o.quadraticCurveTo(cx + s, cy - s * 0.1, cx + s, cy + s * 0.55); o.closePath(); o.fill();
  o.beginPath(); o.arc(cx, cy + s * 0.85, s * 0.28, 0, 7); o.fill();
}
const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Botão "Notificações" (widget): sino, contador de não lidas e o último aviso. */
export function notifWidgetCanvas(W: number, H: number): Canvas {
  const cv = createCanvas(W, H), o = cv.getContext('2d'), wide = W >= H * 1.4, un = unreadCount(), last = items[0];
  o.fillStyle = '#16161a'; o.fillRect(0, 0, W, H); o.textBaseline = 'middle';
  const s = Math.min(W * (wide ? 0.12 : 0.16), H * 0.14), cx = wide ? W * 0.14 : W / 2, cy = wide ? H / 2 : H * 0.24;
  bell(o, cx, cy, s, un ? '#fbbf24' : '#6b7280');
  if (un) { const r = Math.max(6, s * 0.62), bx = cx + s * 0.9, by = cy - s * 0.8; o.fillStyle = '#ef4444'; o.beginPath(); o.arc(bx, by, r, 0, 7); o.fill(); o.fillStyle = '#fff'; o.textAlign = 'center'; o.font = font(r * 1.15); o.fillText(un > 99 ? '99+' : String(un), bx, by + 1, r * 1.8); }
  const tx = wide ? W * 0.28 : W / 2, tw = wide ? W * 0.68 : W - 8; o.textAlign = wide ? 'left' : 'center';
  if (!last) { o.fillStyle = '#9ca3af'; o.font = font(Math.min(W * 0.14, H * 0.14)); o.fillText(tr('sem avisos'), tx, wide ? H / 2 : H * 0.62, tw); return cv; }
  const px = Math.min(wide ? H * 0.17 : W * 0.15, 18);
  o.fillStyle = '#9ca3af'; o.font = font(px * 0.8); o.fillText(last.source || tr('Navegador'), tx, wide ? H * 0.3 : H * 0.5, tw);
  o.fillStyle = '#f4f4f6'; o.font = font(px); wrap(o, last.title || last.body, tw, wide ? 3 : 2).forEach((ln, k) => o.fillText(ln, tx, (wide ? H * 0.46 : H * 0.64) + k * px * 1.2, tw));
  return cv;
}

/** Botões `notif` da página de histórico: mensagem (item), rolar ▲/▼ e Limpar. */
export function notifCanvas(a: Record<string, any>, W: number, H: number, store: Store): Canvas {
  const cv = createCanvas(W, H), o = cv.getContext('2d'), op = String(a.op), total = items.length, step = perPage(store);
  o.fillStyle = '#16161a'; o.fillRect(0, 0, W, H); o.textBaseline = 'middle'; o.textAlign = 'center';
  if (op === 'up' || op === 'down' || op === 'clear') {
    const s = Math.min(W, H) * 0.22; o.fillStyle = op === 'clear' ? '#ef4444' : '#e5e7eb';
    if (op === 'clear') { o.fillRect(W / 2 - s, H * 0.36 - s * 0.55, s * 2, s * 1.5); o.fillRect(W / 2 - s * 1.15, H * 0.36 - s * 0.85, s * 2.3, s * 0.2); }
    else { o.beginPath(); const dy = op === 'up' ? -1 : 1, cy = H * 0.36; o.moveTo(W / 2 - s, cy + dy * s * 0.5); o.lineTo(W / 2 + s, cy + dy * s * 0.5); o.lineTo(W / 2, cy - dy * s * 0.6); o.closePath(); o.fill(); }
    const px = Math.min(W * 0.17, H * 0.17); o.fillStyle = '#9ca3af'; o.font = font(px);
    o.fillText(op === 'clear' ? tr('Limpar') : total ? `${Math.min(total, offset + 1)}-${Math.min(total, offset + step)}/${total}` : '0', W / 2, H * 0.74, W - 6);
    return cv;
  }
  const n = items[offset + Number(a.n)];
  if (!n) { return cv; }
  const px = Math.min(W * 0.13, H * 0.13, 16); o.textAlign = 'left'; o.fillStyle = n.read ? '#6b7280' : '#fbbf24'; o.font = font(px * 0.8);
  o.fillText(`${n.source || tr('Navegador')} · ${hhmm(n.ts)}`, 5, H * 0.1 + px * 0.2, W - 10);
  o.fillStyle = '#f4f4f6'; o.font = font(px); const lines = wrap(o, n.title, W - 10, 2); lines.forEach((ln, k) => o.fillText(ln, 5, H * 0.27 + k * px * 1.2, W - 10));
  const y0 = H * 0.27 + lines.length * px * 1.2 + px * 0.2, room = Math.max(0, Math.floor((H - y0 - 4) / (px * 1.15)));
  o.fillStyle = '#9ca3af'; o.font = font(px * 0.88); if (room) wrap(o, n.body, W - 10, room).forEach((ln, k) => o.fillText(ln, 5, y0 + k * px * 1.15, W - 10));
  return cv;
}
