// Validação do que dá para validar no Windows (CI windows-latest, PowerShell real): teclas de mídia aceitas, leitura de "Tocando agora" (SMTC/WinRT) e do estado do Mudo.
// O EFEITO das teclas (volume mudando) não é medido: o runner não tem placa de som. A leitura do SMTC é testada com uma sessão falsa (test/windows/smtc_player.ps1); se o runner não deixar criá-la, o teste avisa e pula só essa parte.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { platform } from '../src/platform/index.ts';
import { SMTC, psCmd, parseNowPlaying } from '../src/platform/win.ts';
import { runCmd } from '../src/exec.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  console.log('== leitura do script (qualquer sistema)');
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
  check(parseNowPlaying('') === null && parseNowPlaying('lixo') === null, 'saída vazia ou inválida = nada tocando');
  const np0 = parseNowPlaying(b64({ app: 'Spotify.exe', state: 'playing', title: 'Café ☕', artist: 'Ação', art: 'data:image/png;base64,AAAA' }));
  check(np0?.title === 'Café ☕' && np0.artist === 'Ação' && np0.state === 'playing' && np0.app === 'spotify.exe' && np0.art === 'data:image/png;base64,AAAA', 'JSON em base64 com acentos e emoji', JSON.stringify(np0));
  check(parseNowPlaying(b64({ state: 'stopped', title: 'x' })) === null && parseNowPlaying(b64({ state: 'paused', title: 'x', art: 'javascript:alert(1)' }))?.art === undefined, 'estado desconhecido e capa que não é imagem são descartados');
  if (process.platform !== 'win32') { console.log('(o resto só no Windows)'); return; }

  console.log('\n== teclas de mídia');
  for (const k of ['volup', 'voldown', 'mute', 'mute', 'playpause', 'next', 'prev']) { const r = await platform.media(k); check(r[0] === true, `tecla "${k}" aceita pelo PowerShell/keybd_event`, String(r)); }
  const b = await platform.media('brightup'); check(Array.isArray(b) && typeof b[0] === 'boolean' && typeof b[1] === 'string', 'brilho (WMI) responde sem travar (falha esperada sem tela interna)', String(b));
  check((await platform.media('inexistente'))[0] === false, 'tecla inexistente é recusada');
  const m = await platform.muted?.(); check(m === null || typeof m === 'boolean', 'Mudo: leitura responde (null sem placa de som)', String(m));

  console.log('\n== Tocando agora (SMTC)');
  const [rc, out, err] = await runCmd(psCmd(`$want = 0; ${SMTC}`), undefined, 20_000);
  check(rc === 0, 'o script WinRT roda sem erro (a API de mídia do Windows existe e responde)', err.slice(0, 200));
  check(out.trim() === '' && (await platform.nowPlaying?.()) === null, 'sem player aberto: nada tocando (null)', out.slice(0, 120));
  const pl = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows', 'smtc_player.ps1')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; pl.stdout.on('data', (d) => { log += String(d); }); pl.stderr.on('data', (d) => { log += String(d); });
  let got = null as Awaited<ReturnType<NonNullable<typeof platform.nowPlaying>>> | null;
  for (let i = 0; i < 12 && !got; i++) { await sleep(2000); got = (await platform.nowPlaying?.()) ?? null; }
  if (got) { check(got.title === 'Faixa CI' && got.artist === 'Artista CI' && (got.state === 'playing' || got.state === 'paused'), 'lê título, artista e estado de uma sessão de mídia real', JSON.stringify(got).slice(0, 200)); }
  else console.log(`  ! sessão de mídia falsa não apareceu neste runner (pulado). Log do player: ${log.replace(/\s+/g, ' ').slice(0, 300)}`);
  pl.kill();
}
main().then(() => { console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
