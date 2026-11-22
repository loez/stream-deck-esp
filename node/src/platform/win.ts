// Windows: PowerShell 5.1 (já vem no sistema) para tudo que não é só abrir algo: SendKeys (atalhos, digitar), keybd_event (mídia), GetForegroundWindow (app em foco),
// atalhos do Menu Iniciar (.lnk) como lista de apps, System.Drawing (ícones), diálogos do Windows Forms. O .zip é aberto em JS puro (unzip.ts).
// Todo valor vindo do usuário entra nos scripts por base64 (nunca concatenado): sem injeção. Scripts vão por -EncodedCommand.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unzipTo } from './unzip.ts';
import { runCmd } from '../exec.ts';
import { strip } from '../util.ts';
import { keyName } from './types.ts';
import type { AppInfo, Front, Key, NowPlaying, Platform, Result } from './types.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/** Valor de texto dentro de um script PowerShell (decodificado em tempo de execução). */
export const psStr = (s: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;
/** Comando PowerShell que executa o script (erro -> stderr + código 1). */
export function psCmd(script: string, sta = false): string[] {
  const full = `$ErrorActionPreference='Stop'; try { ${script} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  return ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...(sta ? ['-STA'] : []), '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')];
}
const ps = async (script: string, sta = false, timeout = 15_000): Promise<[number, string, string]> => runCmd(psCmd(script, sta), undefined, timeout);
const res = ([rc, o, e]: [number, string, string], okMsg = 'ok'): Result => [rc === 0, rc === 0 ? strip(o) || okMsg : (strip(e.split(/\r?\n/).filter(Boolean).pop() ?? 'erro').slice(0, 80))];

// ---------- atalhos (SendKeys) ----------
const SPECIAL: Record<string, string> = { enter: '{ENTER}', tab: '{TAB}', space: ' ', backspace: '{BACKSPACE}', escape: '{ESC}', delete: '{DELETE}', left: '{LEFT}', right: '{RIGHT}', down: '{DOWN}', up: '{UP}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}' };
/** Texto do SendKeys para um atalho: ^ Ctrl, % Alt, + Shift ("command" vira Ctrl: o Windows não tem Cmd). */
export function sendKeysString(mods: string[], key: Key): string {
  const m = new Set(mods.map((x) => (x === 'command' ? 'control' : x)));
  const k = keyName(key);
  const body = SPECIAL[k] ?? (/^f([1-9]|1[0-2])$/.test(k) ? `{${k.toUpperCase()}}` : '+^%~(){}[]'.includes(k) ? `{${k}}` : k);
  return (m.has('control') ? '^' : '') + (m.has('option') ? '%' : '') + (m.has('shift') ? '+' : '') + body;
}
// Volume geral do Windows pela API Core Audio (COM) em C# compilado na hora pelo PowerShell: W.Vol.Get() devolve 0-1, W.Vol.Set(x) define.
const AUDIO = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
namespace W {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume { int _0(); int _1(); int _2(); int _3(); int SetMasterVolumeLevelScalar(float level, ref Guid ctx); int _5(); int GetMasterVolumeLevelScalar(out float level); int _7(); int _8(); int _9(); int _10(); int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid ctx); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr p, out IAudioEndpointVolume v); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator { int _0(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
  [ComImport, Guid("BCDE0395-E52F-4F03-9F8A-9D5D3AF4B5E9")] class Enumerator { }
  public static class Vol {
    static IAudioEndpointVolume V() { IMMDevice d; ((IMMDeviceEnumerator)(new Enumerator())).GetDefaultAudioEndpoint(0, 1, out d); Guid g = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume v; d.Activate(ref g, 23, IntPtr.Zero, out v); return v; }
    public static float Get() { float f; V().GetMasterVolumeLevelScalar(out f); return f; }
    public static bool Muted() { bool m; V().GetMute(out m); return m; }
    public static void Set(float x) { Guid g = Guid.Empty; V().SetMasterVolumeLevelScalar(x, ref g); }
  }
}
'@;`;
// "Tocando agora": sessões de mídia do Windows (SMTC, Windows 10 1809+), a mesma API da tela de bloqueio/overlay de volume: Spotify, navegador (YouTube...), Groove, VLC etc.
// WinRT pelo PowerShell 5.1 (sem instalar nada). Sai um JSON em base64 (UTF-8: títulos com acento/emoji); a capa só é lida quando $want = 1 (é a parte cara).
export const SMTC = `Add-Type -AssemblyName System.Runtime.WindowsRuntime;
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1') })[0];
function Aw($op, $t) { $k = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$k.Wait(-1); $k.Result }
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime];
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime];
$mgr = Aw ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]);
$pick = $null; $pickSt = 0;
foreach ($s in $mgr.GetSessions()) { $st = [int]$s.GetPlaybackInfo().PlaybackStatus; if ($st -ne 4 -and $st -ne 5) { continue }; if ($pick -eq $null -or ($st -eq 4 -and $pickSt -ne 4)) { $pick = $s; $pickSt = $st } }
if ($pick -ne $null) {
  $p = Aw ($pick.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]);
  $o = @{ app = [string]$pick.SourceAppUserModelId; state = $(if ($pickSt -eq 4) { 'playing' } else { 'paused' }); title = [string]$p.Title; artist = [string]$p.Artist };
  if ($want -eq 1 -and $p.Thumbnail -ne $null) {
    $stm = Aw ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType]);
    if ($stm.Size -gt 0 -and $stm.Size -lt 4000000) { $r = [Windows.Storage.Streams.DataReader]::new($stm); [void](Aw ($r.LoadAsync([uint32]$stm.Size)) ([uint32])); $b = New-Object byte[] ([int]$stm.Size); $r.ReadBytes($b); $o.art = 'data:' + $stm.ContentType + ';base64,' + [Convert]::ToBase64String($b) }
  }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress))))
}`;
/** Saída do script SMTC (JSON em base64, ou vazia = nada tocando) -> faixa. null se vazia ou inválida. */
export function parseNowPlaying(out: string): NowPlaying | null {
  const t = out.trim(); if (!t) return null;
  try {
    const j = JSON.parse(Buffer.from(t, 'base64').toString('utf8')) as Record<string, unknown>;
    if (j.state !== 'playing' && j.state !== 'paused') return null;
    const art = typeof j.art === 'string' && /^data:image\/[a-z+.-]+;base64,/i.test(j.art) ? j.art : undefined;
    return { app: String(j.app ?? '').toLowerCase(), state: j.state, title: String(j.title ?? ''), artist: String(j.artist ?? ''), ...(art ? { art } : {}) };
  } catch { return null; }
}
let artKey = '', artVal: string | undefined;   // a capa só é relida quando a faixa muda (o script com capa é bem mais pesado)
const FORMS = "Add-Type -AssemblyName System.Windows.Forms;";

// ---------- teclas de mídia (keybd_event) ----------
const VK: Record<string, number> = { mute: 0xAD, voldown: 0xAE, volup: 0xAF, next: 0xB0, prev: 0xB1, playpause: 0xB3 };
const KEYBD = "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, int f, int e);' -Name K -Namespace W;";

// ---------- app em foco: um PowerShell fica rodando e imprime o app da frente a cada 0,6 s (abrir um por consulta custaria ~300 ms de CPU cada) ----------
export const FRONT_PS = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);' -Name F -Namespace W;
while ($true) { try { $h = [W.F]::GetForegroundWindow(); $p = [uint32]0; [void][W.F]::GetWindowThreadProcessId($h, [ref]$p); $pr = Get-Process -Id $p -ErrorAction Stop; [Console]::Out.WriteLine(($pr.ProcessName + '.exe').ToLower() + '|' + $pr.ProcessName) } catch { [Console]::Out.WriteLine('|') }; Start-Sleep -Milliseconds 600 }`;
let watcher: ReturnType<typeof spawn> | null = null, latest: Front | null = null, buf = '';
function startWatcher(): void {
  if (watcher) return;
  const full = FRONT_PS;
  const w = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  watcher = w;
  w.stdout!.on('data', (d) => { buf += String(d); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); const [bundle, name] = line.split('|'); latest = bundle ? { bundle, name: name || bundle } : null; } });
  w.on('exit', () => { watcher = null; latest = null; });
  w.on('error', () => { watcher = null; });
  process.on('exit', () => { try { w.kill(); } catch { /* já saiu */ } });
}

// ---------- apps: atalhos do Menu Iniciar ----------
const startMenus = () => [path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
function scanLnk(dir: string, depth: number, out: AppInfo[]): void {
  let ents: fs.Dirent[] = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3) scanLnk(p, depth + 1, out); }
    else if (/\.lnk$/i.test(e.name) && !/uninstall|desinstal|remover|readme|leia-?me|license|licen[cç]a|documenta/i.test(e.name)) out.push({ name: e.name.slice(0, -4), path: p });
  }
}
let targets: Promise<Map<string, string>> | null = null;   // .lnk -> caminho do .exe (todos de uma vez: um PowerShell por atalho seria lento demais)
function lnkTargets(): Promise<Map<string, string>> {
  if (!targets) targets = (async () => {
    const m = new Map<string, string>();
    const roots = startMenus().map((r) => psStr(r)).join(',');
    const [rc, o] = await ps(`$s = New-Object -ComObject WScript.Shell; foreach ($r in @(${roots})) { if (Test-Path -LiteralPath $r) { Get-ChildItem -LiteralPath $r -Recurse -Filter *.lnk | ForEach-Object { [Console]::Out.WriteLine($_.FullName + '|' + $s.CreateShortcut($_.FullName).TargetPath) } } }`, false, 90_000);
    if (rc === 0) for (const l of o.split(/\r?\n/)) { const i = l.lastIndexOf('|'); if (i > 0) m.set(l.slice(0, i), l.slice(i + 1)); }
    return m;
  })();
  return targets;
}
const exeOf = async (p: string): Promise<string> => /\.lnk$/i.test(p) ? (await lnkTargets()).get(p) ?? '' : p;

const win: Platform = {
  id: 'win32', osName: 'Windows',
  async openApp(name, p) {
    const target = p && fs.existsSync(p) ? p : name;
    if (!target) return [false, 'sem aplicativo'];
    return res(await ps(`Start-Process -FilePath (${psStr(target)})`));
  },
  async quitApp(target) {   // fecha a janela principal (como o botão X): só se estiver aberto
    return res(await ps(`$t = ${psStr(target)}; if ($t -like '*.lnk') { $t = (New-Object -ComObject WScript.Shell).CreateShortcut($t).TargetPath }; $n = [IO.Path]::GetFileNameWithoutExtension($t); $p = @(Get-Process -Name $n -ErrorAction SilentlyContinue); if ($p.Count) { $p | ForEach-Object { [void]$_.CloseMainWindow() }; 'fechado' } else { 'nao estava aberto' }`));
  },
  async openUrl(u) { return res(await ps(`Start-Process -FilePath (${psStr(u)})`)); },
  async hotkey(mods, key) { return res(await ps(`${FORMS} [System.Windows.Forms.SendKeys]::SendWait(${psStr(sendKeysString(mods, key))})`, true)); },
  async typeText(t, enter) {   // cola (Ctrl+V): acentos e emojis funcionam; a área de transferência (só texto) é restaurada
    return res(await ps(`${FORMS} $old = Get-Clipboard -Raw -ErrorAction SilentlyContinue; Set-Clipboard -Value (${psStr(t)}); [System.Windows.Forms.SendKeys]::SendWait('^v');${enter ? " Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}');" : ''} Start-Sleep -Milliseconds 300; if ($old) { Set-Clipboard -Value $old } else { [System.Windows.Forms.Clipboard]::Clear() }`, true));
  },
  async media(k) {
    if (k in VK) { const v = VK[k]!; return res(await ps(`${KEYBD} [W.K]::keybd_event(${v}, 0, 0, 0); [W.K]::keybd_event(${v}, 0, 2, 0)`)); }
    if (k === 'brightup' || k === 'brightdown') {   // WMI: só em telas internas (notebooks); monitor externo não aceita
      const d = k === 'brightup' ? 10 : -10;
      return res(await ps(`$l = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness; $n = [Math]::Min(100, [Math]::Max(0, $l + (${d}))); Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=[byte]$n} | Out-Null`));
    }
    return [false, 'tecla de mídia inválida'];
  },
  async resources() {   // GPU: contadores de desempenho "GPU Engine" (qualquer fabricante, Windows 10 1709+): soma do motor 3D; RAM: genérico do Node
    const [rc, o] = await ps(`$s = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction Stop).CounterSamples | Measure-Object -Property CookedValue -Sum; [Console]::Out.WriteLine([int]$s.Sum)`, false, 8000);
    const v = Number(o.trim());
    return { gpu: rc === 0 && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null, ramUsed: null };
  },
  async volumeGet() { const [rc, o] = await ps(`${AUDIO} [Math]::Round([W.Vol]::Get() * 100)`, false, 8000); const v = Number(o.trim()); return rc === 0 && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null; },   // Core Audio (IAudioEndpointVolume), sem programas extras
  async volumeSet(pct) { const [rc] = await ps(`${AUDIO} [W.Vol]::Set(${(Math.max(0, Math.min(100, pct)) / 100).toFixed(2)})`, false, 8000); return rc === 0; },
  async muted() { const [rc, o] = await ps(`${AUDIO} [W.Vol]::Muted()`, false, 8000); return rc === 0 ? /true/i.test(o) : null; },
  async nowPlaying() {
    const np = parseNowPlaying((await ps(`$want = 0; ${SMTC}`, false, 10_000))[1]); if (!np) return null;
    const key = `${np.app}|${np.title}|${np.artist}`;
    if (key !== artKey) { artVal = parseNowPlaying((await ps(`$want = 1; ${SMTC}`, false, 15_000))[1])?.art; artKey = key; }
    return artVal ? { ...np, art: artVal } : np;
  },
  async appVolumeGet() { return null; },   // o Windows tem volume por app (sessões de áudio), mas ainda não está implementado aqui
  async appVolumeSet() { return [false, 'não suportado neste sistema']; },
  async front() { startWatcher(); return latest; },
  isAppPath: (p) => { try { return fs.statSync(p).isFile() || fs.statSync(p).isDirectory(); } catch { return false; } },
  listApps() {
    const out: AppInfo[] = [], seen = new Set<string>();
    for (const r of startMenus()) scanLnk(r, 0, out);
    return out.filter((a) => { const k = a.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  },
  async appId(appPath) { return path.basename(await exeOf(appPath)).toLowerCase(); },   // ex.: "chrome.exe" (casa com o app em foco)
  async extractIcon(appPath, out) {
    const [rc] = await ps(`Add-Type -AssemblyName System.Drawing; $p = ${psStr(appPath)}; if ($p -like '*.lnk') { $t = (New-Object -ComObject WScript.Shell).CreateShortcut($p).TargetPath; if ($t -and (Test-Path -LiteralPath $t)) { $p = $t } }; $i = [System.Drawing.Icon]::ExtractAssociatedIcon($p); $i.ToBitmap().Save(${psStr(out)}, [System.Drawing.Imaging.ImageFormat]::Png)`, false, 20_000);
    return rc === 0 && fs.existsSync(out);
  },
  async pickPath(kind) {
    const dlg = kind === 'zip'
      ? `$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = 'Plugin (*.zip)|*.zip'; $d.Title = 'Escolha o plugin (.zip)'; if ($d.ShowDialog() -eq 'OK') { $d.FileName }`
      : `$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Escolha a pasta do plugin'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`;
    const [rc, o] = await ps(`${FORMS} ${dlg}`, true, 300_000);
    return rc === 0 ? o.trim().replace(/[\\/]$/, '') : '';
  },
  unzip: unzipTo,   // JS puro: não depende de tar/PowerShell
  transient: new Set(['searchhost.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'lockapp.exe', 'taskmgr.exe', 'snippingtool.exe', 'screenclippinghost.exe']),
};
export default win;
