// Teste do botão "Tocando agora": leitura do player (platform.nowPlaying trocado por um falso), capa baixada de um servidor local, chave de versão e desenho.
import http from 'node:http';
import { PNG } from 'pngjs';
import { platform } from '../src/platform/index.ts';
import { widgetKey, widgetRefresh, widgetCanvas, WIDGET_KINDS } from '../src/widgets.ts';
import { lastNowPlaying } from '../src/nowplaying.ts';
import { setLang } from '../src/i18n.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
setLang('pt');
const im = new PNG({ width: 16, height: 16 }); for (let i = 0; i < 16 * 16; i++) { im.data[i * 4] = 220; im.data[i * 4 + 1] = 30; im.data[i * 4 + 2] = 30; im.data[i * 4 + 3] = 255; }
const png = PNG.sync.write(im); let artHits = 0;
const srv = http.createServer((_q, r) => { artHits++; r.writeHead(200, { 'Content-Type': 'image/png' }); r.end(png); });
const px = (cv: any, x: number, y: number) => Array.from(cv.getContext('2d').getImageData(x, y, 1, 1).data) as number[];

async function main() {
  await new Promise<void>((r) => srv.listen(8952, '127.0.0.1', r));
  check((WIDGET_KINDS as readonly string[]).includes('nowplaying'), 'tipo "nowplaying" existe');
  let now: any = null; (platform as any).nowPlaying = async () => now;

  console.log('\n== nada tocando');
  await widgetRefresh('nowplaying'); check(lastNowPlaying() === null && widgetKey('nowplaying') === '-', 'sem player: chave "-"');
  const empty = widgetCanvas('nowplaying', 73, 84); check(empty.width === 73, 'desenha o aviso sem erro');

  console.log('\n== tocando');
  now = { app: 'spotify', state: 'playing', title: 'No Reverse', artist: 'Aurora', art: 'http://127.0.0.1:8952/capa.png' };
  await widgetRefresh('nowplaying'); const k1 = widgetKey('nowplaying');
  check(lastNowPlaying()?.title === 'No Reverse' && k1.includes('No Reverse') && artHits === 1, 'faixa lida e capa baixada uma vez', k1);
  const cv = widgetCanvas('nowplaying', 73, 84), c = px(cv, 36, 25);
  check(c[0]! > 150 && c[1]! < 90, 'a capa (vermelha) aparece no botão', JSON.stringify(c));
  await widgetRefresh('nowplaying'); check(artHits === 1, 'mesma capa: não baixa de novo');
  now = { ...now, state: 'paused' }; await widgetRefresh('nowplaying'); check(widgetKey('nowplaying') !== k1, 'pausar muda a chave (a imagem é redesenhada)');
  now = { ...now, title: 'Outra', art: undefined }; await widgetRefresh('nowplaying'); check(widgetKey('nowplaying').includes('Outra') && widgetCanvas('nowplaying', 150, 70).width === 150, 'sem capa: ícone de reserva; botão largo desenha');
  now = { ...now, art: 'http://127.0.0.1:1/quebrada.png' }; await widgetRefresh('nowplaying'); check(widgetCanvas('nowplaying', 73, 84).width === 73, 'capa que falha não derruba o desenho');
}
main().then(() => { srv.close(); console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0); }).catch((e) => { srv.close(); console.error(e); process.exit(1); });
