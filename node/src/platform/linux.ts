// Linux: xdg-open, arquivos .desktop (lista de apps e ícones), xdotool (atalhos, digitar e app em foco; só X11/XWayland), wtype como alternativa no Wayland,
// playerctl/pactl/brightnessctl (mídia, volume, brilho) com teclas XF86 do xdotool como reserva, zenity/kdialog (seletor); o .zip é aberto em JS puro (unzip.ts).
// Ferramentas que faltam geram uma mensagem dizendo qual instalar (ver docs/PLATAFORMAS.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { unzipTo } from './unzip.ts';
import { runCmd } from '../exec.ts';
import { strip } from '../util.ts';
import { keyName } from './types.ts';
import type { AppInfo, Key, NowPlaying, Platform, Result } from './types.ts';

const out = (cmd: string, args: string[]) => new Promise<string>((r) => execFile(cmd, args, { timeout: 3000 }, (e, o) => r(e ? '' : String(o))));
const missing = (tool: string, how: string): Result => [false, `instale ${tool}${how ? ` (${how})` : ''}`];
const fail = (e: string): Result => [false, strip(e.split(/\r?\n/).filter(Boolean).pop() ?? 'erro').slice(0, 80)];

// ---------- atalhos (xdotool) ----------
const XSPECIAL: Record<string, string> = { enter: 'Return', tab: 'Tab', space: 'space', backspace: 'BackSpace', escape: 'Escape', delete: 'Delete', left: 'Left', right: 'Right', down: 'Down', up: 'Up',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next' };
const XPUNCT: Record<string, string> = { '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'period', '/': 'slash', '`': 'grave' };
/** Argumento do `xdotool key` (ex.: "ctrl+shift+a"); "command" vira Ctrl: o Linux não tem Cmd. */
export function xdotoolKey(mods: string[], key: Key): string {
  const m = new Set(mods.map((x) => (x === 'command' ? 'control' : x)));
  const k = keyName(key);
  const sym = XSPECIAL[k] ?? (/^f([1-9]|1[0-2])$/.test(k) ? k.toUpperCase() : XPUNCT[k] ?? k);
  return [m.has('control') ? 'ctrl' : '', m.has('option') ? 'alt' : '', m.has('shift') ? 'shift' : '', sym].filter(Boolean).join('+');
}
const wayland = () => (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland';
const NOX = 'xdotool (X11/XWayland; no Wayland puro use wtype)';

// ---------- mídia ----------
const MEDIA: Record<string, { cmds: string[][]; xf86: string }> = {
  playpause: { cmds: [['playerctl', 'play-pause']], xf86: 'XF86AudioPlay' },
  next: { cmds: [['playerctl', 'next']], xf86: 'XF86AudioNext' },
  prev: { cmds: [['playerctl', 'previous']], xf86: 'XF86AudioPrev' },
  volup: { cmds: [['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '+5%'], ['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', '5%+']], xf86: 'XF86AudioRaiseVolume' },
  voldown: { cmds: [['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '-5%'], ['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', '5%-']], xf86: 'XF86AudioLowerVolume' },
  mute: { cmds: [['pactl', 'set-sink-mute', '@DEFAULT_SINK@', 'toggle'], ['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']], xf86: 'XF86AudioMute' },
  brightup: { cmds: [['brightnessctl', 'set', '+10%']], xf86: 'XF86MonBrightnessUp' },
  brightdown: { cmds: [['brightnessctl', 'set', '10%-']], xf86: 'XF86MonBrightnessDown' },
};

// ---------- apps: arquivos .desktop ----------
const appDirs = () => ['/usr/share/applications', '/usr/local/share/applications', path.join(os.homedir(), '.local', 'share', 'applications'), '/var/lib/flatpak/exports/share/applications',
  path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'applications'), '/var/lib/snapd/desktop/applications'];
export type Desktop = { name: string; exec: string; icon: string; wmClass: string; show: boolean };
/** Lê o que interessa de um .desktop (seção [Desktop Entry], chaves sem tradução). */
export function parseDesktop(text: string): Desktop {
  const d: Desktop = { name: '', exec: '', icon: '', wmClass: '', show: true };
  let inEntry = false, isApp = true;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('[')) { inEntry = l === '[Desktop Entry]'; continue; }
    if (!inEntry || !l || l.startsWith('#')) continue;
    const i = l.indexOf('='); if (i < 0) continue;
    const k = l.slice(0, i), v = l.slice(i + 1).trim();
    if (k === 'Name') d.name = v; else if (k === 'Exec') d.exec = v; else if (k === 'Icon') d.icon = v; else if (k === 'StartupWMClass') d.wmClass = v;
    else if (k === 'NoDisplay' || k === 'Hidden') { if (v === 'true') d.show = false; }
    else if (k === 'Type') isApp = v === 'Application';
  }
  if (!isApp) d.show = false;
  return d;
}
const readDesktop = (p: string): Desktop | null => { try { return parseDesktop(fs.readFileSync(p, 'utf8')); } catch { return null; } };
/** Nome do executável de uma linha Exec= (ignora env, aspas e códigos %U). */
export function execName(exec: string): string {
  const toks = exec.match(/"[^"]*"|\S+/g) ?? [];
  const t = toks.find((x) => x !== 'env' && !/^[A-Za-z_]+=/.test(x) && !x.startsWith('%')) ?? '';
  return path.basename(t.replace(/^"|"$/g, ''));
}
const iconSearch = (name: string): string | null => {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const bases = ['/usr/share/icons', path.join(os.homedir(), '.local', 'share', 'icons'), '/var/lib/flatpak/exports/share/icons', path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'icons')];
  for (const sz of ['256x256', '512x512', '128x128', '96x96', '64x64', '48x48', 'scalable'])
    for (const b of bases) for (const ext of ['png', 'svg']) { const f = path.join(b, 'hicolor', sz, 'apps', `${name}.${ext}`); if (fs.existsSync(f)) return f; }
  for (const ext of ['png', 'svg']) { const f = path.join('/usr/share/pixmaps', `${name}.${ext}`); if (fs.existsSync(f)) return f; }
  return null;
};

const linux: Platform = {
  id: 'linux', osName: 'Linux',
  async openApp(name, p) {
    if (p && /\.desktop$/.test(p)) {   // gio launch (glib) ou gtk-launch; a saída vai para /dev/null para o comando não ficar preso ao app aberto
      const [rc, , err] = await runCmd(['sh', '-c', 'gio launch "$0" >/dev/null 2>&1 || gtk-launch "$1" >/dev/null 2>&1', p, path.basename(p)]);
      return rc === 0 ? [true, 'ok'] : fail(err || 'não consegui abrir');
    }
    if (!name) return [false, 'sem aplicativo'];
    const byName = linux.listApps().find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (byName) return linux.openApp(name, byName.path);
    const [rc, , err] = await runCmd(['sh', '-c', 'command -v "$0" >/dev/null 2>&1 && { nohup "$0" >/dev/null 2>&1 & }', name]);   // nome de um comando no PATH
    return rc === 0 ? [true, 'ok'] : fail(err || 'aplicativo não encontrado');
  },
  async quitApp(target) {   // SIGTERM ao processo (fecha como Ctrl+C no app); só se estiver rodando
    let exe = target;
    if (/\.desktop$/.test(target)) { const d = readDesktop(target); exe = d ? execName(d.exec) : exe; }
    else { const a = linux.listApps().find((x) => x.name.toLowerCase() === target.toLowerCase()); const d = a && readDesktop(a.path); if (d) exe = execName(d.exec); }
    exe = path.basename(exe).slice(0, 15);   // pkill -x compara só os 15 primeiros caracteres do nome do processo
    const [rc, , err] = await runCmd(['pkill', '-TERM', '-x', exe]);
    return rc === 0 ? [true, 'fechado'] : rc === 1 ? [true, 'nao estava aberto'] : rc === 127 ? missing('pkill', 'procps') : fail(err);
  },
  async openUrl(u) { const [rc, , err] = await runCmd(['xdg-open', u]); return rc === 127 ? missing('xdg-utils', '') : [rc === 0, strip(err) || 'ok']; },
  async hotkey(mods, key) {
    const [rc, , err] = await runCmd(['xdotool', 'key', '--clearmodifiers', xdotoolKey(mods, key)]);
    return rc === 0 ? [true, 'ok'] : rc === 127 ? missing(NOX, '') : fail(err);
  },
  async typeText(t, enter) {
    let [rc, , err] = await runCmd(['xdotool', 'type', '--clearmodifiers', '--delay', '5', '--', t]);
    if (rc === 127 && wayland()) { [rc, , err] = await runCmd(['wtype', '--', t]); if (rc === 127) return missing('wtype ou xdotool', 'Wayland/X11'); }
    else if (rc === 127) return missing(NOX, '');
    if (rc === 0 && enter) [rc, , err] = await runCmd(['xdotool', 'key', 'Return']);
    return rc === 0 ? [true, 'ok'] : fail(err);
  },
  async media(k) {
    const m = MEDIA[k]; if (!m) return [false, 'tecla de mídia inválida'];
    let last = '';
    for (const c of m.cmds) { const [rc, , err] = await runCmd(c); if (rc === 0) return [true, 'ok']; last = rc === 127 ? '' : err; }
    const [rc, , err] = await runCmd(['xdotool', 'key', m.xf86]);   // reserva: a tecla de mídia virtual (o ambiente gráfico trata)
    if (rc === 0) return [true, 'ok'];
    return rc === 127 ? missing(`${m.cmds[0]![0]} (ou xdotool)`, '') : fail(last || err);
  },
  async front() {   // X11/XWayland: classe da janela ativa (= StartupWMClass do .desktop)
    const cls = (await out('xdotool', ['getactivewindow', 'getwindowclassname'])).trim();
    if (!cls) return null;
    return { bundle: cls.toLowerCase(), name: cls };
  },
  isAppPath: (p) => /\.desktop$/.test(p) && fs.existsSync(p),
  listApps() {
    const seen = new Set<string>(), res: AppInfo[] = [];
    for (const dir of appDirs()) {
      let names: string[] = []; try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.desktop') || seen.has(n)) continue;
        const p = path.join(dir, n), d = readDesktop(p);
        if (!d || !d.show || !d.name) continue;
        seen.add(n); res.push({ name: d.name, path: p });
      }
    }
    return res;
  },
  async resources() {   // GPU: nvidia-smi (NVIDIA) ou gpu_busy_percent do kernel (AMD); RAM: MemTotal - MemAvailable
    let gpu: number | null = null;
    const [rc, o] = await runCmd(['nvidia-smi', '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], undefined, 3000);
    if (rc === 0) { const v = o.split(/\r?\n/).map(Number).filter(Number.isFinite); if (v.length) gpu = Math.max(...v); }
    if (gpu === null) try {
      const vs: number[] = [];
      for (const c of fs.readdirSync('/sys/class/drm')) if (/^card\d+$/.test(c)) { try { vs.push(Number(fs.readFileSync(`/sys/class/drm/${c}/device/gpu_busy_percent`, 'utf8'))); } catch { /* sem o arquivo */ } }
      if (vs.length && vs.every(Number.isFinite)) gpu = Math.max(...vs);
    } catch { /* sem /sys/class/drm */ }
    let ramUsed: number | null = null;
    try { const m = fs.readFileSync('/proc/meminfo', 'utf8'), kb = (k: string) => Number(new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(m)?.[1]); const t = kb('MemTotal'), a = kb('MemAvailable'); if (t && Number.isFinite(a)) ramUsed = (t - a) * 1024; } catch { /* genérico */ }
    return { gpu, ramUsed };
  },
  async muted() {   // PulseAudio/PipeWire; senão ALSA
    let [rc, o] = await runCmd(['pactl', 'get-sink-mute', '@DEFAULT_SINK@'], undefined, 3000);
    if (rc === 0) return /yes|sim/i.test(o);
    [rc, o] = await runCmd(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@'], undefined, 3000);
    return rc === 0 ? /MUTED/.test(o) : null;
  },
  async nowPlaying() {   // MPRIS via playerctl: primeiro player que está tocando; senão o primeiro pausado
    const [rc, o] = await runCmd(['playerctl', '-a', 'metadata', '--format', '{{status}}\x1f{{title}}\x1f{{artist}}\x1f{{mpris:artUrl}}\x1f{{playerName}}'], undefined, 3000);
    if (rc !== 0) return null;
    let paused: NowPlaying | null = null;
    for (const line of o.split('\n')) {
      const [st, title, artist, art, app] = line.split('\x1f'); if (st !== 'Playing' && st !== 'Paused') continue;
      const np: NowPlaying = { app: app ?? '', state: st === 'Playing' ? 'playing' : 'paused', title: title ?? '', artist: artist ?? '', ...(art && /^(https?|file):/.test(art) ? { art } : {}) };
      if (np.state === 'playing') return np; paused ??= np;
    }
    return paused;
  },
  async volumeGet() {   // PulseAudio/PipeWire (pactl); senão ALSA (amixer)
    let [rc, o] = await runCmd(['pactl', 'get-sink-volume', '@DEFAULT_SINK@'], undefined, 3000);
    let m = rc === 0 ? /(\d+)%/.exec(o) : null;
    if (!m) { [rc, o] = await runCmd(['amixer', 'sget', 'Master'], undefined, 3000); m = rc === 0 ? /\[(\d+)%\]/.exec(o) : null; }
    return m ? Math.max(0, Math.min(100, Number(m[1]))) : null;
  },
  async volumeSet(pct) {
    const p = Math.round(Math.max(0, Math.min(100, pct)));
    const [rc] = await runCmd(['pactl', 'set-sink-volume', '@DEFAULT_SINK@', `${p}%`], undefined, 3000);
    return rc === 0 || (await runCmd(['amixer', '-q', 'sset', 'Master', `${p}%`], undefined, 3000))[0] === 0;
  },
  async appVolumeGet(app) {   // playerctl (MPRIS): só o Spotify
    if (app !== 'spotify') return null;
    const [rc, o] = await runCmd(['playerctl', '-p', 'spotify', 'volume'], undefined, 3000); const v = Number(o.trim());
    return rc === 0 && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 100))) : null;
  },
  async appVolumeSet(app, pct) {
    if (app !== 'spotify') return [false, 'app sem controle de volume'];
    const [rc, , e] = await runCmd(['playerctl', '-p', 'spotify', 'volume', String(Math.max(0, Math.min(1, pct / 100)).toFixed(2))], undefined, 3000);
    return rc === 0 ? [true, 'ok'] : [false, rc === 127 ? 'instale o playerctl' : 'Spotify fechado'];
  },
  async appId(appPath) {   // WM_CLASS (StartupWMClass) ou o nome do executável: casa com a classe da janela em foco
    const d = readDesktop(appPath); if (!d) return '';
    return (d.wmClass || execName(d.exec) || path.basename(appPath, '.desktop')).toLowerCase();
  },
  async extractIcon(appPath, out) {
    const d = readDesktop(appPath); const src = d?.icon ? iconSearch(d.icon) : null;
    if (!src) return false;
    if (src.endsWith('.png')) { fs.copyFileSync(src, out); return true; }
    try {   // SVG: o canvas desenha em 256x256
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const img = await loadImage(fs.readFileSync(src)), cv = createCanvas(256, 256), c = cv.getContext('2d'); c.drawImage(img, 0, 0, 256, 256);
      fs.writeFileSync(out, cv.toBuffer('image/png')); return true;
    } catch { return false; }
  },
  async pickPath(kind) {
    const tries: string[][] = kind === 'zip'
      ? [['zenity', '--file-selection', '--title=Escolha o plugin (.zip)', '--file-filter=*.zip'], ['kdialog', '--getopenfilename', os.homedir(), '*.zip']]
      : [['zenity', '--file-selection', '--directory', '--title=Escolha a pasta do plugin'], ['kdialog', '--getexistingdirectory', os.homedir()]];
    for (const c of tries) { const [rc, o] = await runCmd(c, undefined, 300_000); if (rc === 0) return o.trim().replace(/\/$/, ''); if (rc !== 127) return ''; }
    return '';   // sem zenity/kdialog: a página pede para colar o caminho
  },
  unzip: unzipTo,   // JS puro: não depende de unzip/bsdtar instalados
  transient: new Set([]),
};
export default linux;
