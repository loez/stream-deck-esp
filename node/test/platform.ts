// Testa a camada de sistema (src/platform): montagem de atalhos, leitura de .desktop, segurança dos scripts do PowerShell e os comandos gerados no Windows e no Linux
// (modo DECK_DRYRUN: só imprime, então roda em qualquer sistema). Uso: DECK_DRYRUN=1 node test/platform.ts
process.env.DECK_DRYRUN = '1';
import { isDeepStrictEqual } from 'node:util';
const { default: win, sendKeysString, psCmd, psStr } = await import('../src/platform/win.ts');
const { default: linux, xdotoolKey, parseDesktop, execName } = await import('../src/platform/linux.ts');
const { default: mac, keystrokeScript } = await import('../src/platform/mac.ts');
const { parseHotkey } = await import('../src/actions.ts');

let fails = 0, total = 0;
const check = (ok: boolean, msg: string, extra = '') => { total++; if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : ' ' + extra}`); };
const eq = (a: unknown, b: unknown, msg: string) => check(isDeepStrictEqual(a, b), msg, `\n      esperado=${JSON.stringify(b)}\n      obtido  =${JSON.stringify(a)}`);
const hk = (s: string) => parseHotkey(s);
/** Captura as linhas "[dryrun] [...]" que runCmd imprime. */
async function capture(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [], orig = console.log;
  console.log = (...a: unknown[]) => { const s = a.join(' '); if (s.startsWith('[dryrun]')) lines.push(s); else orig(...a); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

console.log('\n== Windows: atalhos (SendKeys)');
eq(sendKeysString(...(hk('ctrl+c').slice(0, 2) as [string[], any])), '^c', 'ctrl+c -> ^c');
eq(sendKeysString(...(hk('cmd+shift+4').slice(0, 2) as [string[], any])), '^+4', 'cmd+shift+4 -> ^+4 (cmd vira Ctrl)');
eq(sendKeysString(...(hk('alt+f4').slice(0, 2) as [string[], any])), '%{F4}', 'alt+f4 -> %{F4}');
eq(sendKeysString(...(hk('enter').slice(0, 2) as [string[], any])), '{ENTER}', 'enter -> {ENTER}');
eq(sendKeysString(...(hk('ctrl+left').slice(0, 2) as [string[], any])), '^{LEFT}', 'ctrl+left -> ^{LEFT}');
eq(sendKeysString([], ['char', '['] as any), '{[}', 'caractere especial entre chaves');

console.log('\n== Linux: atalhos (xdotool)');
eq(xdotoolKey(...(hk('cmd+c').slice(0, 2) as [string[], any])), 'ctrl+c', 'cmd+c -> ctrl+c');
eq(xdotoolKey(...(hk('ctrl+alt+left').slice(0, 2) as [string[], any])), 'ctrl+alt+Left', 'ctrl+alt+left -> ctrl+alt+Left');
eq(xdotoolKey(...(hk('shift+f12').slice(0, 2) as [string[], any])), 'shift+F12', 'shift+f12 -> shift+F12');
eq(xdotoolKey(...(hk('ctrl+[').slice(0, 2) as [string[], any])), 'ctrl+bracketleft', 'pontuação vira keysym');
eq(xdotoolKey(...(hk('pagedown').slice(0, 2) as [string[], any])), 'Next', 'pagedown -> Next');

console.log('\n== macOS: script igual ao de sempre');
eq(keystrokeScript(...(hk('cmd+shift+4').slice(0, 2) as [string[], any])), 'tell application "System Events" to keystroke "4" using {command down, shift down}', 'cmd+shift+4');

console.log('\n== Linux: arquivos .desktop');
const d = parseDesktop('[Desktop Entry]\nType=Application\nName=Firefox\nName[pt_BR]=Navegador\nExec=env MOZ_ENABLE=1 /usr/lib/firefox/firefox %u\nIcon=firefox\nStartupWMClass=firefox\n[Desktop Action new]\nName=Nova janela\nExec=firefox --new-window\n');
eq([d.name, d.icon, d.wmClass, d.show], ['Firefox', 'firefox', 'firefox', true], 'campos da seção principal (sem traduções nem ações)');
eq(execName(d.exec), 'firefox', 'executável ignora env, variável e %u');
eq(parseDesktop('[Desktop Entry]\nType=Application\nName=X\nNoDisplay=true\n').show, false, 'NoDisplay=true some da lista');
eq(parseDesktop('[Desktop Entry]\nType=Link\nName=X\n').show, false, 'só Type=Application entra');
eq(execName('"/opt/Meu App/app" --flag %F'), 'app', 'Exec com aspas');

console.log('\n== Windows: os scripts do PowerShell não recebem texto do usuário cru');
const evil = `"; Remove-Item -Recurse C:\\ ; '`;
const script = Buffer.from(psCmd(`Write-Output (${psStr(evil)})`).at(-1)!, 'base64').toString('utf16le');
check(!script.includes('Remove-Item') && script.includes('FromBase64String'), 'valor entra por base64 (sem injeção)');
check(psCmd('1').includes('-EncodedCommand') && psCmd('1', true).includes('-STA'), 'usa -EncodedCommand e -STA quando pedido');

console.log('\n== comandos gerados (dry-run)');
let l = await capture(() => win.openUrl('https://exemplo.com/?a=1&b=2'));
check(l.length === 1 && l[0]!.includes("'powershell'") && !l[0]!.includes('exemplo'), 'Windows: abrir site via PowerShell com a URL em base64', l.join('|'));
l = await capture(() => linux.openUrl('https://exemplo.com/?a=1&b=2'));
eq(l, ["[dryrun] ['xdg-open', 'https://exemplo.com/?a=1&b=2'] "], 'Linux: xdg-open com a URL como argumento');
l = await capture(() => linux.hotkey(...(hk('cmd+c').slice(0, 2) as [string[], any])));
eq(l, ["[dryrun] ['xdotool', 'key', '--clearmodifiers', 'ctrl+c'] "], 'Linux: atalho via xdotool');
l = await capture(() => linux.media('volup'));
check(l.length === 1 && l[0]!.includes("'pactl'") && l[0]!.includes('+5%'), 'Linux: volume + via pactl', l.join('|'));
l = await capture(() => linux.openApp('Firefox', ''));
check(l.length >= 1 && l[0]!.includes("'sh'") , 'Linux: abrir app sem .desktop cai no comando do PATH', l.join('|'));
l = await capture(() => linux.quitApp('/usr/share/applications/firefox.desktop'));
check(l.length === 1 && l[0]!.includes("'pkill'") && l[0]!.includes("'-x'"), 'Linux: fechar app via pkill -x', l.join('|'));
l = await capture(() => mac.openApp('Safari', ''));
eq(l, ["[dryrun] ['open', '-a', 'Safari'] "], 'macOS: open -a (inalterado)');
l = await capture(() => mac.openUrl('https://exemplo.com'));
eq(l, ["[dryrun] ['open', '--', 'https://exemplo.com'] "], 'macOS: open -- url (inalterado)');

console.log('\n== listas e identificadores em máquina sem os apps');
check(Array.isArray(linux.listApps()) && Array.isArray(win.listApps()) && Array.isArray(mac.listApps()), 'listApps devolve lista (vazia se não há apps) sem lançar');
check(linux.isAppPath('/nao/existe.desktop') === false && linux.isAppPath('/etc/hostname') === false, 'Linux: isAppPath exige .desktop existente');

console.log('\n' + '='.repeat(60) + `\n${total} verificações, ${fails} falha(s)`);
process.exit(fails ? 1 : 0);
