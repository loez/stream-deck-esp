// Botão "Tocando agora" (widget): lê a faixa do player pela camada de plataforma (platform.nowPlaying) e guarda título, artista e capa para o desenho (widgets.ts).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadImage } from '@napi-rs/canvas';
import type { Image } from '@napi-rs/canvas';
import { platform } from './platform/index.ts';
import type { NowPlaying } from './platform/types.ts';

let cur: NowPlaying | null = null, art: Image | null = null, artUrl = '', artBusy = false, artFail = '';
export const lastNowPlaying = (): NowPlaying | null => cur;
export const lastArt = (): Image | null => art;

async function fetchArt(url: string): Promise<void> {
  if (artBusy || url === artFail) return; artBusy = true;
  try {
    let buf: Buffer;
    if (url.startsWith('file:')) buf = fs.readFileSync(fileURLToPath(url));
    else if (url.startsWith('data:')) buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');   // Windows: a capa vem embutida
    else { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 5_000_000) throw new Error('capa grande demais'); }
    art = await loadImage(buf); artUrl = url; artFail = '';
  } catch { artFail = url; art = null; artUrl = ''; }
  finally { artBusy = false; }
}

/** Relê o player (chamado a cada poucos segundos enquanto existir um botão "Tocando agora") e baixa a capa se mudou. */
export async function nowPlayingRefresh(): Promise<void> {
  cur = (await platform.nowPlaying?.().catch(() => null)) ?? null;
  if (!cur?.art) { art = null; artUrl = ''; return; }
  if (cur.art !== artUrl) await fetchArt(cur.art);
}
/** Chave do que o botão mostra (a versão sobe quando muda). */
export const nowPlayingKey = (): string => cur ? `${cur.state}|${cur.title}|${cur.artist}|${art ? '1' : ''}` : '-';
