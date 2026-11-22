// Compacta o app empacotado (app/dist/<pasta>) num arquivo para distribuir: app/dist/Stream-Deck-ESP-<versão>-<plataforma>-<arch>.(zip|tar.gz)
// Roda depois de `npm run dist`. No macOS usa `ditto` (preserva links simbólicos e permissões do .app; um zip comum quebra a assinatura).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(APP, 'dist');
const PLAT = process.env.DIST_PLATFORM || process.platform;
const { version } = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const dir = fs.readdirSync(DIST).find((d) => d.startsWith(`Stream Deck ESP-${PLAT}-${process.arch}`));
if (!dir) throw new Error(`rode "npm run dist" antes (nada em ${DIST} para ${PLAT}-${process.arch})`);
const nome = `Stream-Deck-ESP-${version}-${{ darwin: 'mac', win32: 'windows', linux: 'linux' }[PLAT]}-${process.arch}`;
const saida = path.join(DIST, nome + (PLAT === 'linux' ? '.tar.gz' : '.zip'));
fs.rmSync(saida, { force: true });
if (PLAT === 'darwin') {
  const appPath = path.join(DIST, dir, 'Stream Deck ESP.app');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, saida], { stdio: 'inherit' });
  // Instalador .dmg: o app + atalho para Applications + "Liberar.command" (tira a quarentena do macOS; o app não é notarizado pela Apple)
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sdesp-dmg-'));
  try {
    execFileSync('/usr/bin/ditto', [appPath, path.join(stage, 'Stream Deck ESP.app')], { stdio: 'inherit' });
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    const cmd = path.join(stage, 'Liberar app (rodar depois de arrastar).command');
    fs.writeFileSync(cmd, '#!/bin/bash\n# App sem assinatura da Apple: remove a quarentena para o macOS abrir sem reclamar.\nxattr -dr com.apple.quarantine "/Applications/Stream Deck ESP.app" && echo "Pronto: abra o Stream Deck ESP." || echo "Arraste o app para Applications primeiro."\nread -n 1 -s -r -p "Pressione uma tecla para fechar"\n', { mode: 0o755 });
    const dmg = saida.replace(/\.zip$/, '.dmg');
    fs.rmSync(dmg, { force: true });
    execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'Stream Deck ESP', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' });
    console.log('instalador:', dmg);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
} else if (PLAT === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${path.join(DIST, dir)}' -DestinationPath '${saida}' -Force`], { stdio: 'inherit' });
} else {
  execFileSync('tar', ['-czf', saida, '-C', DIST, dir], { stdio: 'inherit' });
}
console.log('pacote:', saida);
