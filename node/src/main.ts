// Servidor do Stream Deck em TypeScript. Uso: npm start   (variáveis: DECK_PORT, DECK_DATA, DECK_NOMDNS=1, DECK_DRYRUN=1)
import fs from 'node:fs';
import { PORT, DATA, UPLOADS, CACHE } from './env.ts';
import { Store } from './config.ts';
import { NOPLUGINS, NOFOCUS } from './env.ts';
import { AutoSwitch } from './focus.ts';
import { PluginHost } from './plugins.ts';
import { createServer, advertise, lanIps } from './server.ts';

// Erros de rede passageiros (multicast/mDNS sem permissão, rede caiu) não derrubam o servidor; qualquer outro erro inesperado ainda encerra.
process.on('uncaughtException', (e: NodeJS.ErrnoException) => {
  if (['EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENETDOWN'].includes(String(e?.code))) { console.log(`[rede] erro ignorado: ${e.message}`); return; }
  console.error(e); process.exit(1);
});
fs.mkdirSync(UPLOADS, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });
const store = new Store();
let host: PluginHost | null = NOPLUGINS ? null : new PluginHost(store);
if (host && !(await host.start())) host = null;   // porta dos plugins ocupada: segue sem plugins
const focus = NOFOCUS ? null : new AutoSwitch(store);
focus?.start();
const server = createServer(store, host, focus);
// Rodando dentro do app (Electron): se o app morrer sem avisar, o servidor não fica órfão segurando a porta
const parent = Number(process.env.DECK_PARENT_PID || 0);
if (parent) setInterval(() => { try { process.kill(parent, 0); } catch { console.log('app encerrado: servidor saindo'); process.exit(0); } }, 4000).unref();
server.listen(PORT, '0.0.0.0', () => {
  const stop = advertise(PORT), ips = lanIps();
  console.log(`Stream Deck (Node) rodando.\n  Configurar: http://localhost:${PORT}\n  Rede: ${ips.map((ip) => `${ip}:${PORT}`).join(', ')}  ${stop ? '(anunciado como _streamdeck._tcp)' : '(sem anúncio mDNS)'}\n  Dados: ${DATA}`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop?.(); host?.stop(); focus?.stop(); server.close(); setTimeout(() => process.exit(0), 200); });
});
