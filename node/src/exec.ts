// Execução de comandos do sistema (usada pelas ações e pela camada platform/). No modo de teste (DECK_DRYRUN) só imprime o comando.
import { spawn } from 'node:child_process';
import { DRY } from './env.ts';
import { pyRepr, slice } from './util.ts';

/** Ambiente dos comandos que o servidor dispara (open, osascript...). Rodando dentro do app Electron o servidor tem ELECTRON_RUN_AS_NODE=1, e o `open` repassa o ambiente
 *  ao app aberto: um app Electron (Discord, VS Code...) herdaria isso, viraria um Node comum e fecharia na hora. As variáveis internas (DECK_*) também não vazam. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('DECK_')) delete env[k];
  return env;
}

/** Executa um comando (ou, no modo de teste, só imprime no mesmo formato do servidor Python). Retorna [código, stdout, stderr]. */
export function runCmd(cmd: string[], input?: string, timeout = 15_000): Promise<[number, string, string]> {
  if (DRY) { console.log('[dryrun]', pyRepr(cmd.slice(0, 5)), slice(input ?? '', 0, 60)); return Promise.resolve([0, '', '']); }
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const p = spawn(cmd[0]!, cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: cleanEnv() });
    const finish = (code: number) => { if (!done) { done = true; clearTimeout(timer); resolve([code, out, err]); } };
    const timer = setTimeout(() => { err += 'timeout'; p.kill('SIGKILL'); finish(124); }, timeout);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { err += e.message; finish(127); });
    p.on('close', (code) => finish(code ?? -1));
    p.stdin.on('error', () => {}); p.stdin.end(input ?? '');
  });
}

/** Mensagem amigável quando o macOS nega o envio de teclas (permissão de Acessibilidade). */
export function axError(err: string): string {
  if (/1002|assistive|not allowed|n[ãa]o [ée] permitido|n[ãa]o tem permiss/i.test(err || '')) return 'sem permissão de Acessibilidade';
  const lines = err.trim().split(/\r?\n/).filter((l) => l.length || false);
  return slice(lines.length ? lines[lines.length - 1]! : 'erro', 0, 80);
}

