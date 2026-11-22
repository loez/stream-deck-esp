// macOS: osascript/System Events (atalhos, digitar), `open`, lsappinfo (app em foco), plutil/JXA/sips (apps e ícones), ditto (.zip).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { ASSETS } from '../env.ts';
import { unzipTo } from './unzip.ts';
import { axError, runCmd } from '../exec.ts';
import { slice, sleep, strip } from '../util.ts';
import type { AppInfo, Front, Key, NowPlaying, Platform, Result } from './types.ts';

const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const run = (cmd: string, args: string[], timeout: number) => new Promise<boolean>((res) => execFile(cmd, args, { timeout }, (e) => res(!e)));
const out = (cmd: string, args: string[]) => new Promise<string>((res) => execFile(cmd, args, { timeout: 3000 }, (e, o) => res(e ? '' : String(o))));

/** Só entram no script valores já validados (lista branca): sem injeção. */
export function keystrokeScript(mods: string[], key: Key): string {
  const using = mods.length ? ` using {${mods.map((m) => m + ' down').join(', ')}}` : '';
  return 'tell application "System Events" to ' + (key[0] === 'code' ? `key code ${key[1]}` : `keystroke "${key[1]}"`) + using;
}

const MAC_MUSIC: Record<string, string> = { spotify: 'Spotify', music: 'Music' };   // lista branca: só estes nomes entram no AppleScript
let lastAsn = '', lastFront: Front | null = null;
const bundleCache = new Map<string, string>();

const mac: Platform = {
  id: 'darwin', osName: 'macOS',
  async openApp(name, p) {
    const cmd = p && isDir(p) ? ['open', '--', p] : name ? ['open', '-a', name] : null;
    if (!cmd) return [false, 'sem aplicativo'];
    const [rc, , err] = await runCmd(cmd); return [rc === 0, strip(err) || 'ok'];
  },
  async quitApp(target) {   // só fecha se estiver aberto: "tell application ... to quit" abriria um app fechado antes de fechá-lo
    const script = 'on run argv\n set a to item 1 of argv\n if application a is running then\n tell application a to quit\n return "fechado"\n end if\n return "nao estava aberto"\nend run';
    const [rc, o, err] = await runCmd(['osascript', '-e', script, '--', target]);
    return [rc === 0, rc === 0 ? strip(o) || 'ok' : slice(strip(err.split('\n').filter(Boolean).pop() ?? 'erro'), 0, 80)];
  },
  async openUrl(u) { const [rc, , err] = await runCmd(['open', '--', u]); return [rc === 0, strip(err) || 'ok']; },
  async hotkey(mods, key) { const [rc, , err] = await runCmd(['osascript', '-e', keystrokeScript(mods, key)]); return [rc === 0, rc === 0 ? 'ok' : axError(err)]; },
  async typeText(t, enter) {   // cola o texto (⌘V): funciona com acentos e emojis; a área de transferência (só texto) é restaurada
    const [, old] = await runCmd(['pbpaste']); await runCmd(['pbcopy'], t);
    let [rc, , err] = await runCmd(['osascript', '-e', keystrokeScript(['command'], ['char', 'v'])]);
    if (rc === 0 && enter) { await sleep(150); [rc, , err] = await runCmd(['osascript', '-e', keystrokeScript([], ['code', 36])]); }
    await sleep(300); await runCmd(['pbcopy'], old);
    return [rc === 0, rc === 0 ? 'ok' : axError(err)];
  },
  async media(k) {
    // Volume e mudo por AppleScript: o evento HID de tecla de volume é ignorado pelo macOS recente (o script devolvia "ok" e nada mudava). Passo de 1/16, como a tecla física.
    if (k === 'volup' || k === 'voldown') {
      const [rc, o] = await runCmd(['osascript', '-e', `set v to output volume of (get volume settings)\nset volume output volume (${k === 'volup' ? 'v + 6.25' : 'v - 6.25'})\nset volume without output muted\nreturn output volume of (get volume settings)`]);
      return [rc === 0, rc === 0 ? 'ok' : strip(o)];
    }
    if (k === 'playpause' || k === 'next' || k === 'prev') {   // mesmo motivo: a tecla HID não chega ao player. Controla direto o Spotify/Music (o que estiver tocando; senão o que estiver aberto) e só cai na tecla HID se nenhum estiver aberto
      const cmd = k === 'playpause' ? 'playpause' : k === 'next' ? 'next track' : 'previous track';
      for (const onlyPlaying of [true, false]) for (const app of Object.values(MAC_MUSIC)) {
        const [rc, o] = await runCmd(['osascript', '-e', `if application "${app}" is running then\ntell application "${app}"\n${onlyPlaying ? 'if player state is not playing then return "x"\n' : ''}${cmd}\nend tell\nreturn "ok"\nelse\nreturn "x"\nend if`]);
        if (rc === 0 && strip(o) === 'ok') return [true, 'ok'];
      }
    }
    if (k === 'brightup' || k === 'brightdown') {   // códigos de tecla de brilho do macOS (144/145) via System Events; a tecla HID não chega
      const [rc, o] = await runCmd(['osascript', '-e', `tell application "System Events" to key code ${k === 'brightup' ? 144 : 145}`]);
      return [rc === 0, rc === 0 ? 'ok' : axError(o)];
    }
    if (k === 'mute') { const [rc, o] = await runCmd(['osascript', '-e', 'set volume output muted (not (output muted of (get volume settings)))']); return [rc === 0, rc === 0 ? 'ok' : strip(o)]; }
    const [rc, , err] = await runCmd(['osascript', '-l', 'JavaScript', path.join(ASSETS, 'media.js'), k]); return [rc === 0, rc === 0 ? 'ok' : axError(err)]; },
  async front() {   // lsappinfo: nativo, sem permissão de Acessibilidade/Automação
    const asn = (await out('lsappinfo', ['front'])).trim();
    if (!asn.startsWith('ASN:')) return null;
    if (asn === lastAsn && lastFront) return lastFront;   // mesmo processo na frente: não precisa perguntar de novo
    const info = await out('lsappinfo', ['info', '-only', 'bundleid', '-only', 'name', asn]);
    const bundle = /bundleID="([^"]+)"/.exec(info)?.[1] ?? '', name = /^"([^"]+)"/.exec(info.trim())?.[1] ?? bundle;
    lastAsn = asn; lastFront = bundle ? { bundle, name } : null;
    return lastFront;
  },
  async resources() {   // GPU: ioreg (IOAccelerator, sem sudo; Apple Silicon e AMD/Intel). RAM como o Monitor de Atividade: anônima + fixa (wired) + comprimida
    const gpuTxt = await out('ioreg', ['-r', '-d', '1', '-w0', '-c', 'IOAccelerator']);
    const g = [...gpuTxt.matchAll(/"Device Utilization %"=(\d+)/g)].map((m) => Number(m[1]));
    const vm = await out('vm_stat', []), page = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 0);
    const n = (k: string) => Number(new RegExp(k + ':\\s+(\\d+)').exec(vm)?.[1] ?? NaN);
    const pages = n('Anonymous pages') + n('Pages wired down') + n('Pages occupied by compressor');
    return { gpu: g.length ? Math.min(100, Math.max(...g)) : null, ramUsed: page && Number.isFinite(pages) ? pages * page : null };
  },
  async muted() { const [rc, o] = await runCmd(['osascript', '-e', 'output muted of (get volume settings)']); return rc === 0 ? strip(o) === 'true' : null; },
  async nowPlaying() {   // Spotify e Music, só se já estiverem abertos (nunca abre); prefere o que está tocando
    let paused: NowPlaying | null = null;
    for (const [name, art] of [['Spotify', 'artwork url of current track'], ['Music', '""']] as const) {
      const [rc, o] = await runCmd(['osascript', '-e', `set sp to (ASCII character 31)\nif application "${name}" is running then\ntell application "${name}"\nset ps to player state as string\nif ps is "playing" or ps is "paused" then return ps & sp & (name of current track) & sp & (artist of current track) & sp & (${art})\nend tell\nend if\nreturn ""`]);
      if (rc !== 0) continue;
      const [st, title, artist, artUrl] = o.replace(/\n$/, '').split('\x1f'); if (!title && st !== 'playing' && st !== 'paused') continue;
      const np: NowPlaying = { app: name.toLowerCase(), state: st === 'playing' ? 'playing' : 'paused', title: title ?? '', artist: artist ?? '', ...(artUrl && /^https?:/.test(artUrl) ? { art: artUrl } : {}) };
      if (np.state === 'playing') return np; paused ??= np;
    }
    return paused;
  },
  async volumeGet() { const [rc, o] = await runCmd(['osascript', '-e', 'output volume of (get volume settings)']); const v = Number(strip(o)); return rc === 0 && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null; },
  async volumeSet(pct) { const [rc] = await runCmd(['osascript', '-e', `set volume output volume ${Math.round(Math.max(0, Math.min(100, pct)))}`]); return rc === 0; },
  async appVolumeGet(app) {   // só lê se o app já estiver aberto (nunca abre o app)
    const name = MAC_MUSIC[app]; if (!name) return null;
    const [rc, o] = await runCmd(['osascript', '-e', `if application "${name}" is running then\ntell application "${name}" to return sound volume\nelse\nreturn "-1"\nend if`]); const v = Number(strip(o));
    return rc === 0 && Number.isFinite(v) && v >= 0 ? Math.min(100, v) : null;
  },
  async appVolumeSet(app, pct) {
    const name = MAC_MUSIC[app]; if (!name) return [false, 'app sem controle de volume'];
    const [rc, o, e] = await runCmd(['osascript', '-e', `if application "${name}" is running then\ntell application "${name}" to set sound volume to ${Math.round(Math.max(0, Math.min(100, pct)))}\nreturn "ok"\nelse\nreturn "fechado"\nend if`]);
    return rc !== 0 ? [false, axError(e)] : strip(o) === 'fechado' ? [false, 'app fechado'] : [true, 'ok'];
  },
  isAppPath: isDir,
  listApps() {
    const seen = new Set<string>(); const res: AppInfo[] = [];
    for (const d of ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')]) {
      let names: string[] = [];
      try { names = fs.readdirSync(d); } catch { continue; }
      for (const n of names) if (n.endsWith('.app') && !seen.has(n)) { seen.add(n); res.push({ name: n.slice(0, -4), path: path.join(d, n) }); }
    }
    return res;
  },
  appId(appPath) {   // bundle id (com.apple.Safari...) lido do Info.plist
    if (!appPath.endsWith('.app')) return Promise.resolve('');
    const hit = bundleCache.get(appPath); if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((res) => execFile('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], { timeout: 5000 }, (e, o) => { const id = e ? '' : String(o).trim(); bundleCache.set(appPath, id); res(id); }));
  },
  async extractIcon(real, f) {   // JXA (NSWorkspace) entrega 1024x1024 de 16 bits; sips reduz para 256 (decodificar o grande custava ~70 MB de RAM)
    const tmp = f.replace(/\.png$/, '.big.png');
    if (await run('osascript', ['-l', 'JavaScript', path.join(ASSETS, 'icon.js'), real, tmp], 20_000) && fs.existsSync(tmp)) {
      if (!(await run('sips', ['-z', '256', '256', tmp, '--out', f], 10_000)) || !fs.existsSync(f)) fs.copyFileSync(tmp, f);   // sem sips: usa o grande mesmo
      fs.rmSync(tmp, { force: true });
    }
    return fs.existsSync(f);
  },
  async pickPath(kind) {
    const script = kind === 'zip' ? 'POSIX path of (choose file with prompt "Escolha o plugin (.zip)" of type {"public.zip-archive"})' : 'POSIX path of (choose folder with prompt "Escolha a pasta do plugin")';
    const [rc, o] = await runCmd(['osascript', '-e', script], undefined, 300_000);
    return rc === 0 ? o.trim().replace(/\/$/, '') : '';
  },
  unzip(zip, dest) { try { execFileSync('/usr/bin/ditto', ['-x', '-k', zip, dest], { timeout: 120_000, stdio: 'ignore' }); } catch { unzipTo(zip, dest); } },   // ditto preserva os atributos do Mac; sem ele (ou se falhar), o extrator em JS
  transient: new Set(['com.apple.dock', 'com.apple.loginwindow', 'com.apple.spotlight', 'com.apple.notificationcenterui', 'com.apple.controlcenter', 'com.apple.systemuiserver', 'com.apple.screencaptureui', 'com.apple.universalcontrol']),
};
export default mac;
