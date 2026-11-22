// Validação REAL dos botões de mídia no Linux (CI/Docker): PulseAudio com saída virtual + player MPRIS falso (test/linux/mpris_mock.py) sob um barramento D-Bus de sessão.
// Fora do Linux não faz nada. Preparação: ver o job "linux-midia" em .github/workflows/streamdeck.yml (ou test/linux/rodar-docker.sh).
import { platform } from '../src/platform/index.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  if (process.platform !== 'linux') { console.log('(só no Linux)'); return; }
  console.log('== volume e mudo (PulseAudio)');
  check(await platform.volumeSet(50), 'volumeSet(50)'); await sleep(200);
  const v0 = await platform.volumeGet(); check(v0 !== null && Math.abs(v0 - 50) <= 2, 'volumeGet ≈ 50', String(v0));
  let r = await platform.media('volup'); await sleep(200); const v1 = await platform.volumeGet();
  check(r[0] && v1 !== null && v0 !== null && v1 > v0, 'Volume + sobe', `${r} ${v0}->${v1}`);
  r = await platform.media('voldown'); await sleep(200); const v2 = await platform.volumeGet();
  check(r[0] && v2 !== null && v1 !== null && v2 < v1, 'Volume - desce', `${r} ${v1}->${v2}`);
  check((await platform.muted?.()) === false, 'começa sem mudo');
  r = await platform.media('mute'); await sleep(200); check(r[0] && (await platform.muted?.()) === true, 'Mudo liga', String(r));
  r = await platform.media('mute'); await sleep(200); check(r[0] && (await platform.muted?.()) === false, 'Mudo desliga', String(r));

  console.log('\n== player (MPRIS via playerctl)');
  let np = await platform.nowPlaying?.();
  check(np?.state === 'playing' && np.title === 'Mock Song' && np.artist === 'Mock Artist' && np.art === 'http://127.0.0.1:9/capa.png', 'nowPlaying lê título, artista, capa e estado', JSON.stringify(np));
  r = await platform.media('playpause'); await sleep(300); np = await platform.nowPlaying?.(); check(r[0] && np?.state === 'paused', 'Play/Pausa pausa', `${r} ${np?.state}`);
  r = await platform.media('playpause'); await sleep(300); np = await platform.nowPlaying?.(); check(r[0] && np?.state === 'playing', 'Play/Pausa retoma', `${r} ${np?.state}`);
  r = await platform.media('next'); await sleep(300); np = await platform.nowPlaying?.(); check(r[0] && np?.title === 'Mock Song 2', 'Próxima faixa', `${r} ${np?.title}`);
  r = await platform.media('prev'); await sleep(300); np = await platform.nowPlaying?.(); check(r[0] && np?.title === 'Mock Song', 'Faixa anterior', `${r} ${np?.title}`);

  console.log('\n== brilho (sem tela interna no contêiner)');
  r = await platform.media('brightup'); check(r[0] === false && typeof r[1] === 'string' && r[1].length > 0, 'Brilho sem brightnessctl/tela: falha com mensagem, sem travar', String(r));
}
main().then(() => { console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
