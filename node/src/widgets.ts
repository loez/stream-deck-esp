// Botões "Relógio" e "Clima" (ação `widget`): no modo normal são imagens desenhadas pelo servidor (como o Monitor de Recursos) e atualizadas por um relógio do servidor;
// no modo autônomo a própria placa desenha o relógio e o clima (standalone.ts / firmware).
import { createCanvas } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { getLang, tr } from './i18n.ts';
import { getStandalone, setStandalone, tzOf } from './standalone.ts';
import { lastArt, lastNowPlaying, nowPlayingKey, nowPlayingRefresh } from './nowplaying.ts';
import { notifKey, notifWidgetCanvas } from './notify.ts';
import { fetchWeather, lastWeather, locateByIp, weatherIcon, wmoInfo } from './weather.ts';

export const WIDGET_KINDS = ['clock', 'weather', 'nowplaying', 'notifications'] as const;

export function clockParts(now = new Date(), s = getStandalone()): { hm: string; date: string; secs: string } {
  const tz = tzOf(s), loc = getLang() === 'en' ? 'en-US' : 'pt-BR';
  const hm = new Intl.DateTimeFormat(loc, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: !s.clock.h24 }).format(now).replace(/\s?[ap]\.?m\.?/i, (m) => m.trim().toUpperCase().replace(/\./g, ''));
  const date = new Intl.DateTimeFormat(loc, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(now).replace(/\./g, '');
  const secs = new Intl.DateTimeFormat(loc, { timeZone: tz, second: '2-digit' }).format(now);
  return { hm, date, secs };
}

/** Chave do que o botão mostra agora (muda só quando a imagem muda): serve de versão. */
export function widgetKey(kind: string): string {
  if (kind === 'clock') return clockParts().hm;
  if (kind === 'nowplaying') return nowPlayingKey();
  if (kind === 'notifications') return notifKey();
  const w = lastWeather(); return w ? `${w.temp}|${w.code}|${w.isDay}` : '-';
}
/** Sem cidade escolhida: descobre a cidade aproximada pelo IP (uma tentativa a cada 10 min enquanto falhar; para de vez quando o usuário escolhe/apaga a cidade ou há cidade). Devolve true se definiu. */
let locBusy = false, locAt = 0;
export async function ensureLocation(force = false): Promise<boolean> {
  const s = getStandalone();
  if (!force && (s.weather || !s.locAuto)) return false;
  if (locBusy || (!force && Date.now() - locAt < 10 * 60_000)) return false;
  locBusy = true; locAt = Date.now();
  try {
    const p = await locateByIp(); if (!p) return false;
    setStandalone({ weather: { name: p.name, lat: p.lat, lon: p.lon, units: s.weather?.units ?? 'c', ...(p.tz ? { tz: p.tz } : {}), auto: true }, locAuto: true }, true);
    return true;
  } finally { locBusy = false; }
}
/** Atualiza o que o botão precisa (clima: busca na internet, com cache). */
export async function widgetRefresh(kind: string, force = false): Promise<void> {
  if (kind === 'nowplaying') return nowPlayingRefresh();
  if (kind !== 'weather') return;
  await ensureLocation();
  const w = getStandalone().weather; if (w) await fetchWeather(w.lat, w.lon, w.units, force);
}

/** Desenha o widget (W x H do botão; juntado = maior). */
export function widgetCanvas(kind: string, W: number, H: number): Canvas {
  const cv = createCanvas(W, H), o = cv.getContext('2d'), wide = W >= H * 1.4;
  o.fillStyle = '#16161a'; o.fillRect(0, 0, W, H); o.textBaseline = 'middle'; o.textAlign = 'center';
  const font = (px: number) => `bold ${Math.max(7, Math.round(px))}px MontserratDeck`;
  if (kind === 'clock') {
    const { hm, date } = clockParts(), big = Math.min(W / (hm.length * 0.62), H * (wide ? 0.55 : 0.4));
    o.fillStyle = '#f4f4f6'; o.font = font(big); o.fillText(hm, W / 2, H * 0.43);
    o.fillStyle = '#9ca3af'; o.font = font(Math.max(8, Math.min(big * 0.34, W * 0.13))); o.fillText(date, W / 2, H * 0.43 + big * 0.78);
    return cv;
  }
  if (kind === 'notifications') return notifWidgetCanvas(W, H);
  if (kind === 'nowplaying') {
    const np = lastNowPlaying(), art = lastArt();
    if (!np) { const px = Math.min(W * 0.16, H * 0.15); o.fillStyle = '#9ca3af'; o.font = font(px); const ls = tr('nada tocando').split(' '); ls.forEach((ln, k) => o.fillText(ln, W / 2, H / 2 + (k - (ls.length - 1) / 2) * px * 1.25, W - 6)); return cv; }
    const side = wide ? Math.min(H * 0.8, W * 0.34) : Math.min(W * 0.8, H * 0.5), x0 = wide ? W * 0.06 : (W - side) / 2, y0 = wide ? (H - side) / 2 : H * 0.05;
    if (art) { o.save(); o.beginPath(); o.roundRect(x0, y0, side, side, side * 0.08); o.clip(); o.drawImage(art, x0, y0, side, side); o.restore(); }
    else { o.fillStyle = '#2b2d36'; o.beginPath(); o.roundRect(x0, y0, side, side, side * 0.08); o.fill(); o.fillStyle = '#9ca3af'; o.beginPath(); const c = side * 0.18, cx = x0 + side / 2, cy = y0 + side / 2; o.arc(cx - c, cy + c * 0.9, c * 0.7, 0, 7); o.fill(); o.fillRect(cx - c * 0.35, cy - c * 1.7, c * 0.3, c * 2.6); }
    const dot = Math.max(5, side * 0.2), gx = x0 + side - dot * 0.8, gy = y0 + side - dot * 0.8;   // ▶ / ❚❚ desenhados (a fonte do botão não tem esses símbolos)
    o.fillStyle = 'rgba(0,0,0,0.62)'; o.beginPath(); o.arc(gx, gy, dot * 0.95, 0, 7); o.fill(); o.fillStyle = '#fff';
    if (np.state === 'playing') { o.fillRect(gx - dot * 0.4, gy - dot * 0.45, dot * 0.28, dot * 0.9); o.fillRect(gx + dot * 0.12, gy - dot * 0.45, dot * 0.28, dot * 0.9); }
    else { o.beginPath(); o.moveTo(gx - dot * 0.28, gy - dot * 0.5); o.lineTo(gx + dot * 0.5, gy); o.lineTo(gx - dot * 0.28, gy + dot * 0.5); o.closePath(); o.fill(); }
    const tx = wide ? x0 + side + W * 0.04 : W / 2, tw = wide ? W - tx - W * 0.04 : W - 6, ty = wide ? H * 0.38 : y0 + side + H * 0.1, tp = Math.min(wide ? H * 0.2 : W * 0.15, 20);
    o.textAlign = wide ? 'left' : 'center'; o.fillStyle = '#f4f4f6'; o.font = font(tp); o.fillText(np.title, tx, ty, tw);
    o.fillStyle = '#9ca3af'; o.font = font(tp * 0.8); o.fillText(np.artist, tx, ty + tp * 1.3, tw);
    return cv;
  }
  const cfg = getStandalone().weather, w = lastWeather();
  if (!cfg || !w) {
    const words = (cfg ? tr('sem dados') : tr('escolha a cidade')).split(' '), mid = Math.ceil(words.length / 2), lines = words.length > 1 && !wide ? [words.slice(0, mid).join(' '), words.slice(mid).join(' ')] : [words.join(' ')];
    const px = Math.min(W * 0.17, H * 0.16); o.fillStyle = '#9ca3af'; o.font = font(px); lines.forEach((ln, k) => o.fillText(ln, W / 2, H / 2 + (k - (lines.length - 1) / 2) * px * 1.25, W - 6));
    return cv;
  }
  const info = wmoInfo(w.code, w.isDay), unit = cfg.units === 'f' ? '°F' : '°C';
  if (wide) {
    const is = Math.min(H * 0.8, W * 0.34); o.drawImage(weatherIcon(info.kind, Math.round(is)), W * 0.06, (H - is) / 2);
    o.textAlign = 'left'; o.fillStyle = '#f4f4f6'; o.font = font(H * 0.4); o.fillText(`${w.temp}${unit}`, W * 0.06 + is + W * 0.03, H * 0.4);
    o.fillStyle = '#9ca3af'; o.font = font(Math.min(H * 0.15, W * 0.07)); o.fillText(tr(info.text), W * 0.06 + is + W * 0.03, H * 0.72);
  } else {
    const is = Math.min(W * 0.62, H * 0.5); o.drawImage(weatherIcon(info.kind, Math.round(is)), (W - is) / 2, H * 0.04);
    o.fillStyle = '#f4f4f6'; o.font = font(Math.min(W * 0.3, H * 0.26)); o.fillText(`${w.temp}${unit}`, W / 2, H * 0.04 + is + H * 0.14);
  }
  return cv;
}
