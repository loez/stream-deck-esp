// Clima (Open-Meteo: gratuito, sem chave; HTTPS no servidor, HTTP puro na placa) e os ícones do tempo, desenhados com o canvas.
// O servidor usa isto para os botões "Clima" (imagem) e para os ícones que vão à placa no perfil autônomo (a placa só mostra a imagem).
import { createCanvas } from '@napi-rs/canvas';
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';

export type WeatherKind = 'sun' | 'moon' | 'partly' | 'cloud' | 'fog' | 'rain' | 'storm' | 'snow';
export const WEATHER_KINDS: WeatherKind[] = ['sun', 'moon', 'partly', 'cloud', 'fog', 'rain', 'storm', 'snow'];
export type Weather = { temp: number; code: number; isDay: boolean; at: number };
export type Place = { name: string; lat: number; lon: number; tz?: string; admin?: string; country?: string };

const API = () => process.env.DECK_OPENMETEO || 'https://api.open-meteo.com';
const GEO = () => process.env.DECK_OPENMETEO_GEO || 'https://geocoding-api.open-meteo.com';

/** Código WMO do Open-Meteo -> ícone e descrição (pt-BR; o inglês vem de tr()). */
export function wmoInfo(code: number, isDay = true): { kind: WeatherKind; text: string } {
  if (code === 0 || code === 1) return { kind: isDay ? 'sun' : 'moon', text: code === 0 ? 'Céu limpo' : 'Predominantemente limpo' };
  if (code === 2) return { kind: 'partly', text: 'Parcialmente nublado' };
  if (code === 3) return { kind: 'cloud', text: 'Nublado' };
  if (code === 45 || code === 48) return { kind: 'fog', text: 'Neblina' };
  if (code >= 51 && code <= 57) return { kind: 'rain', text: 'Garoa' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { kind: 'rain', text: 'Chuva' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { kind: 'snow', text: 'Neve' };
  if (code >= 95) return { kind: 'storm', text: 'Tempestade' };
  return { kind: 'cloud', text: 'Nublado' };
}

let cache: { key: string; w: Weather } | null = null, inflight: Promise<Weather | null> | null = null;
/** Última leitura (sem rede). */
export const lastWeather = (): Weather | null => cache?.w ?? null;

/** Busca o clima atual (cache de 10 min por local/unidade). null se não deu (sem internet etc.); nesse caso mantém a última leitura. */
export function fetchWeather(lat: number, lon: number, units: 'c' | 'f' = 'c', force = false): Promise<Weather | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${units}`;
  if (!force && cache && cache.key === key && Date.now() - cache.w.at < 10 * 60_000) return Promise.resolve(cache.w);
  inflight ??= (async () => {
    try {
      const u = `${API()}/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day&temperature_unit=${units === 'f' ? 'fahrenheit' : 'celsius'}&timezone=auto`;
      const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'StreamDeckESP' } });
      if (!r.ok) return null;
      const j = (await r.json()) as { current?: { temperature_2m?: number; weather_code?: number; is_day?: number } };
      const c = j.current; if (!c || typeof c.temperature_2m !== 'number' || typeof c.weather_code !== 'number') return null;
      const w: Weather = { temp: Math.round(c.temperature_2m), code: c.weather_code, isDay: c.is_day !== 0, at: Date.now() };
      cache = { key, w }; return w;
    } catch { return null; } finally { inflight = null; }
  })();
  return inflight;
}

/** Cidade aproximada pelo IP público (ipwho.is: HTTPS, sem chave). O serviço só vê o IP de quem pergunta; nenhum outro dado vai junto. DECK_NOIPGEO=1 desliga. null se não deu. */
export async function locateByIp(): Promise<Place | null> {
  if (process.env.DECK_NOIPGEO) return null;
  try {
    const r = await fetch(`${process.env.DECK_IPGEO || 'https://ipwho.is'}/?fields=success,city,region,country,latitude,longitude,timezone`, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'StreamDeckESP' } });
    if (!r.ok) return null;
    const j = (await r.json()) as { success?: boolean; city?: string; region?: string; country?: string; latitude?: number; longitude?: number; timezone?: { id?: string } | string };
    if (j.success === false || !j.city || !Number.isFinite(j.latitude) || !Number.isFinite(j.longitude)) return null;
    const tz = typeof j.timezone === 'string' ? j.timezone : j.timezone?.id;
    return { name: j.city, lat: Math.round(j.latitude! * 1000) / 1000, lon: Math.round(j.longitude! * 1000) / 1000, admin: j.region, country: j.country, ...(tz ? { tz } : {}) };
  } catch { return null; }
}

/** Busca de cidade (Open-Meteo geocoding). */
export async function geocode(q: string): Promise<Place[]> {
  const name = String(q ?? '').trim().slice(0, 80); if (name.length < 2) return [];
  const r = await fetch(`${GEO()}/v1/search?name=${encodeURIComponent(name)}&count=6&language=pt&format=json`, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'StreamDeckESP' } });
  if (!r.ok) throw new Error('a busca de cidades não respondeu');
  const j = (await r.json()) as { results?: { name: string; latitude: number; longitude: number; timezone?: string; admin1?: string; country?: string }[] };
  return (j.results ?? []).filter((x) => Number.isFinite(x.latitude) && Number.isFinite(x.longitude)).map((x) => ({ name: x.name, lat: Math.round(x.latitude * 1000) / 1000, lon: Math.round(x.longitude * 1000) / 1000, tz: x.timezone, admin: x.admin1, country: x.country }));
}

// ---------- ícones ----------
function cloud(c: SKRSContext2D, x: number, y: number, s: number, col: string) {   // nuvem com o centro em (x,y), largura ~s
  c.fillStyle = col; c.beginPath();
  c.arc(x - s * 0.22, y + s * 0.04, s * 0.2, 0, Math.PI * 2); c.arc(x + s * 0.02, y - s * 0.1, s * 0.27, 0, Math.PI * 2); c.arc(x + s * 0.27, y + s * 0.05, s * 0.19, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.roundRect(x - s * 0.42, y + s * 0.02, s * 0.84, s * 0.23, s * 0.11); c.fill();
}
function sun(c: SKRSContext2D, x: number, y: number, r: number) {
  c.fillStyle = '#fbbf24'; c.strokeStyle = '#fbbf24'; c.lineWidth = Math.max(2, r * 0.22); c.lineCap = 'round';
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; c.beginPath(); c.moveTo(x + Math.cos(a) * r * 1.45, y + Math.sin(a) * r * 1.45); c.lineTo(x + Math.cos(a) * r * 1.85, y + Math.sin(a) * r * 1.85); c.stroke(); }
}
/** Ícone do tempo, quadrado `size` x `size`, fundo transparente. */
export function weatherIcon(kind: WeatherKind, size: number): Canvas {
  const cv = createCanvas(size, size), c = cv.getContext('2d'), s = size, m = s / 2;
  c.lineCap = 'round'; c.lineJoin = 'round';
  if (kind === 'sun') sun(c, m, m, s * 0.2);
  else if (kind === 'moon') { c.fillStyle = '#e5e7eb'; c.beginPath(); c.arc(m, m, s * 0.3, 0, Math.PI * 2); c.fill(); c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.arc(m + s * 0.14, m - s * 0.08, s * 0.26, 0, Math.PI * 2); c.fill(); c.globalCompositeOperation = 'source-over'; }
  else if (kind === 'partly') { sun(c, m - s * 0.12, m - s * 0.14, s * 0.15); cloud(c, m + s * 0.06, m + s * 0.1, s * 0.8, '#d1d5db'); }
  else if (kind === 'cloud') cloud(c, m, m, s * 0.9, '#cfd6e2');
  else if (kind === 'fog') { c.strokeStyle = '#cbd5e1'; c.lineWidth = s * 0.07; for (const [y, a, b] of [[0.34, 0.2, 0.8], [0.5, 0.12, 0.88], [0.66, 0.24, 0.76]] as [number, number, number][]) { c.beginPath(); c.moveTo(s * a, s * y); c.lineTo(s * b, s * y); c.stroke(); } }
  else if (kind === 'rain') { cloud(c, m, m - s * 0.1, s * 0.85, '#aab4c3'); c.strokeStyle = '#60a5fa'; c.lineWidth = s * 0.06; for (const x of [0.34, 0.5, 0.66]) { c.beginPath(); c.moveTo(s * x, s * 0.66); c.lineTo(s * (x - 0.05), s * 0.84); c.stroke(); } }
  else if (kind === 'storm') { cloud(c, m, m - s * 0.12, s * 0.85, '#8b95a5'); c.fillStyle = '#fbbf24'; c.beginPath(); c.moveTo(s * 0.54, s * 0.56); c.lineTo(s * 0.4, s * 0.76); c.lineTo(s * 0.5, s * 0.76); c.lineTo(s * 0.44, s * 0.92); c.lineTo(s * 0.62, s * 0.68); c.lineTo(s * 0.52, s * 0.68); c.closePath(); c.fill(); }
  else { cloud(c, m, m - s * 0.1, s * 0.85, '#aab4c3'); c.fillStyle = '#e0f2fe'; for (const [x, y] of [[0.34, 0.72], [0.5, 0.82], [0.66, 0.72]] as [number, number][]) { c.beginPath(); c.arc(s * x, s * y, s * 0.04, 0, Math.PI * 2); c.fill(); } }
  return cv;
}
