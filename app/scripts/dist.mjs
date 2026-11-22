// Empacota o app (Stream Deck ESP; o nome evita colidir com o app da Elgato) em app/dist com o @electron/packager, para o sistema em que roda (macOS, Windows ou Linux).
// No macOS sem assinatura da Apple: o app roda neste Mac (assinatura ad hoc).
import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAT = process.env.DIST_PLATFORM || process.platform;   // darwin | win32 | linux: empacota para o sistema em que roda (os módulos nativos, como o canvas, são do sistema que instalou o npm)
const MAC = PLAT === 'darwin';
// macOS: identidade de assinatura fixa. O certificado local "Stream Deck ESP Local" (autoassinado, no chaveiro de login; veja README) mantém a MESMA identidade do app entre rebuilds, então o macOS não perde a permissão de Rede
// Sem ele, cai na assinatura ad hoc ('-'), que muda a cada build. Outra identidade: SIGN_IDENTITY=<nome>.
const WANT = process.env.SIGN_IDENTITY || 'Stream Deck ESP Local';
let SIGN_ID = '-';
if (MAC) {
  try { if (execFileSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' }).includes(`"${WANT}"`)) SIGN_ID = WANT; } catch { /* ad hoc */ }
  console.log('assinatura:', SIGN_ID === '-' ? 'ad hoc (muda a cada build)' : SIGN_ID);
}
const ICON = { darwin: 'icon.icns', win32: 'icon.ico' }[PLAT];
const out = await packager({
  dir: APP, out: path.join(APP, 'dist'), name: 'Stream Deck ESP', platform: PLAT, arch: process.arch, overwrite: true, asar: false, prune: true,
  ...(ICON ? { icon: path.join(APP, 'build', ICON) } : {}),
  ignore: [/^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/\.gitignore$/, /\.map$/, /\/(test|tests|docs|example|examples)\/.*\.(md|ts)$/],
  ...(MAC ? {
    appBundleId: 'io.github.loez.stream-deck-esp', appCategoryType: 'public.app-category.utilities',
    osxSign: { identity: SIGN_ID, identityValidation: false, optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }) },   // identidade fixa (permissões do macOS, como Rede Local, sobrevivem a rebuilds) ou ad hoc
    extendInfo: { NSAppleEventsUsageDescription: 'O Stream Deck usa o System Events para enviar atalhos de teclado e digitar texto quando você toca num botão.', LSMinimumSystemVersion: '12.0',
      NSLocalNetworkUsageDescription: 'O Stream Deck ESP anuncia o servidor na rede local para a placa (ESP32) encontrá-lo e receber os toques dela.', NSBonjourServices: ['_streamdeck._tcp'] },
  } : {}),
});
console.log('app gerado em', out.join(', '));
