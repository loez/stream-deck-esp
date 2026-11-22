// Compila o servidor TypeScript (../node/src) para JavaScript em app/server e copia os arquivos que ele lê (assets, página de configuração).
// O Node dentro do Electron não precisa mais "tirar os tipos" em tempo de execução (isso custava ~28 MB de RAM).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), APP = path.resolve(HERE, '..'), NODE = path.resolve(APP, '..', 'node'), OUT = path.join(APP, 'server');
fs.rmSync(OUT, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(NODE, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], { cwd: NODE, stdio: 'inherit' });   // por node + script (o .bin/tsc não é executável no Windows)
for (const d of ['assets', 'web']) fs.cpSync(path.join(NODE, d), path.join(OUT, d), { recursive: true, filter: (s) => !s.endsWith('.DS_Store') });
console.log('servidor compilado em', OUT);
