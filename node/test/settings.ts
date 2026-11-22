// Teste da grade (2x2 a 4x4) e da fonte do nome dos botões (src/settings.ts + /api/settings). Pastas temporárias, porta 8806, sem mDNS, sem plugins.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-settings-')), DATA = path.join(TMP, 'data'), PORT = 8806, TOKEN = 'settings-test-token-0123456789abcdef';
const BOARD = { 'User-Agent': 'StreamDeckESP/1', 'X-Deck': TOKEN };
let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
type Resp = { status: number; json: any; len: number };
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length) } : {}), ...headers } }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j: any; try { j = JSON.parse(buf.toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode || 0, json: j, len: buf.length }); });
  });
  r.on('error', reject); r.end(b);
});
let srv: ChildProcess;
function start(): Promise<void> {
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_DRYRUN: '1' } });
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
}
const deck = async () => (await req('GET', '/api/deck', undefined, BOARD)).json;
const set = (b: unknown) => req('PUT', '/api/settings', b);
const press = (i: number) => req('POST', `/api/press/${i}`, undefined, BOARD);

let STR = 8;   // colunas da grade virtual (vem de /api/settings)
const S = (row: number, col: number) => row * STR + col;   // slot da página de um botão (linha, coluna)
async function main() {
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 });
  await start(); STR = (await req('GET', '/api/settings')).json.stride;

  section('1. padrão: 4x2, fonte 12 (como sempre foi)');
  let d = await deck();
  check(d.cols === 4 && d.rows === 2 && d.w === 73 && d.h === 96 && d.bar === 32 && d.font === 12 && d.buttons.length === 8, 'deck padrão', JSON.stringify({ ...d, buttons: d.buttons.length }));
  check((await req('GET', '/api/img/0.raw', undefined, BOARD)).len === 73 * 96 * 2 && (await req('GET', '/api/img/8.raw', undefined, BOARD)).status === 404, 'imagem 73x96; botão 8 não existe');

  section('2. validação');
  for (const [b, w] of [[{ cols: 1 }, 'colunas 1'], [{ cols: 5 }, 'colunas 5'], [{ rows: 6 }, 'linhas 6'], [{ font: 9 }, 'fonte 9'], [{ font: 17 }, 'fonte 17'], [{ cols: '3' }, 'texto'], [{ font: 12.5 }, 'fração'], [{ status: 'sim' }, 'status não booleano'], [[], 'lista']] as const)
    check((await set(b)).status === 400, `recusa ${w}`);
  check((await req('GET', '/api/settings')).json.cols === 4, 'nada mudou depois dos pedidos inválidos');

  section('3. grade 3x3 e fonte 14');
  const rev0 = (await req('GET', '/api/config')).json.rev;
  const r = await set({ cols: 3, rows: 3, font: 14 }); d = await deck();
  check(r.status === 200 && d.cols === 3 && d.rows === 3 && d.buttons.length === 9 && d.w === 99 && d.h === 62 && d.font === 14, 'deck 3x3', JSON.stringify({ ...d, buttons: d.buttons.length }));
  check((await req('GET', '/api/config')).json.rev > rev0, 'rev sobe (a placa relê tudo)');
  check((await req('GET', '/api/img/8.raw', undefined, BOARD)).len === 99 * 62 * 2 && (await req('GET', '/api/img/9.raw', undefined, BOARD)).status === 404, 'imagem 99x62; botão 9 não existe');
  check(d.buttons.every((b: any) => b.fs <= 14 && b.fs >= 10), 'fonte de cada botão fica entre 10 e a escolhida');
  const cfg = (await req('GET', '/api/config')).json; check(cfg.pages[0].buttons.length === STR * 3, `páginas ganham slots vazios (${STR} colunas virtuais x 3 linhas = ${STR * 3})`);

  section('4. posição do botão se mantém na grade virtual');
  await req('PUT', `/api/button/1/${S(1, 1)}`, { label: 'Meio', action: { type: 'text', text: 'oi' } });   // linha 1, coluna 1
  d = await deck(); check(d.buttons[4].label.replace(/\n/g, ' ') === 'Meio', 'o botão da linha 1, coluna 1 aparece na posição 4 da grade 3x3', JSON.stringify(d.buttons[4]));
  const p = await press(4); check(p.status === 200 && p.json.ok === true, 'tocar na posição 4 aciona o botão da linha 1, coluna 1');
  await set({ cols: 4, rows: 2 }); d = await deck();
  check(d.buttons[5].label.replace(/\n/g, ' ') === 'Meio', 'na grade 4x2 o mesmo botão volta para o índice 5');

  section('5. botões fora da grade ficam guardados');
  await req('PUT', `/api/button/1/${S(1, 3)}`, { label: 'Canto', action: { type: 'text', text: 'x' } });
  await set({ cols: 2, rows: 2 }); d = await deck();
  check(d.buttons.length === 4 && d.w === 152 && d.h === 96, '2x2: 152x96', JSON.stringify({ w: d.w, h: d.h, n: d.buttons.length }));
  check((await req('GET', '/api/config')).json.pages[0].buttons[S(1, 3)].label === 'Canto', 'botão escondido continua na configuração');
  await set({ cols: 4, rows: 2 }); d = await deck(); check(d.buttons[7].label.replace(/\n/g, ' ') === 'Canto', 'volta a aparecer quando a grade cresce');

  section('6. 4x4: botão 73x45, nome em 1 linha');
  await set({ cols: 4, rows: 4, font: 12 }); d = await deck();
  check(d.w === 73 && d.h === 45 && d.bar === 16 && d.buttons.length === 16, '4x4', JSON.stringify({ w: d.w, h: d.h, bar: d.bar }));
  check(d.buttons.every((b: any) => !b.label.includes('\n')), 'nenhum nome com 2 linhas');
  check((await req('GET', '/api/img/15.raw', undefined, BOARD)).len === 73 * 45 * 2, 'imagem 73x45');
  const pv = await req('GET', '/api/preview/1/0.png'); check(pv.status === 200, 'prévia gera');
  const np = (await req('POST', '/api/page', { name: 'Nova' })).json.id as number;
  const pg = (await req('GET', '/api/config')).json.pages.find((x: any) => x.id === np);
  check(pg.buttons.length === STR * 4 && pg.buttons[S(3, 3)].action?.op === 'home', 'página nova: "Início" no canto inferior direito visível (linha 3, coluna 3)');

  section('7. a escolha sobrevive ao reinício');
  const revAntes = (await deck()).buttons[0].img;
  await set({ cols: 3, rows: 2, font: 11 }); srv.kill(); await new Promise((r2) => setTimeout(r2, 400)); await start(); d = await deck();
  check(d.buttons[0].img !== revAntes && d.buttons[0].img < 2 ** 31, 'depois de reiniciar o servidor a versão das imagens é DIFERENTE da anterior (a placa não fica com imagem velha por coincidência de números) e cabe em int32', `antes=${revAntes} depois=${d.buttons[0].img}`);
  check(d.cols === 3 && d.rows === 2 && d.font === 11, 'settings.json relido', JSON.stringify({ c: d.cols, r: d.rows, f: d.font }));
  const fit = (await req('GET', '/api/fit?text=' + encodeURIComponent('Abrir terminal do projeto agora'))).json;
  check(fit.fs <= 11 && fit.text.split('\n').length <= 2, '/api/fit usa a geometria escolhida', JSON.stringify(fit));

  section('8. sem título: sem texto e sem faixa preta');
  await set({ cols: 4, rows: 2, font: 12 });
  await req('PUT', '/api/button/1/0', { label: '', action: { type: 'url', url: 'github.com' } });
  d = await deck(); check(d.buttons[0].label === '' && d.buttons[1].label === '', 'botão com ação mas sem título: texto vazio (e botão vazio também)', JSON.stringify(d.buttons.slice(0, 2)));
  const img0 = (await req('GET', '/api/img/0.raw', undefined, BOARD)), revT = d.buttons[0].img;
  await req('PUT', '/api/button/1/0', { label: 'Site', action: { type: 'url', url: 'github.com' } });
  d = await deck(); check(d.buttons[0].label === 'Site' && d.buttons[0].img > revT, 'ao preencher o título ele aparece e a imagem é refeita (ícone menor, com faixa)', JSON.stringify(d.buttons[0]) + ' revT=' + revT);
  await req('PUT', '/api/button/1/0', { label: '', action: { type: 'url', url: 'github.com' } });
  d = await deck(); check(d.buttons[0].label === '', 'ao apagar o título o texto some de novo');
  check(img0.len === 73 * 96 * 2, 'imagem do botão sem título tem o tamanho cheio');

  section('9. ícone sugerido: app, sequência com app e "ir para" uma página com app vinculado');
  const raw = async (i: number) => (await fetch(`http://127.0.0.1:${PORT}/api/img/${i}.raw`, { headers: BOARD }).then((r) => r.arrayBuffer()).then((b) => Buffer.from(b)));
  const calc = { type: 'app', app: 'Calculator', path: '/System/Applications/Calculator.app' };
  const pB = (await req('POST', '/api/page', { name: 'Calc' })).json.id as number, pC = (await req('POST', '/api/page', { name: 'Sem app' })).json.id as number;
  await req('PUT', '/api/button/1/1', { label: '', action: calc });
  await req('PUT', '/api/button/1/2', { label: '', action: { type: 'page', op: 'goto', page: pB } });
  await req('PUT', '/api/button/1/3', { label: '', action: { type: 'multi', mode: 'seq', keep: false, steps: [{ type: 'text', text: 'x' }, calc, { type: 'page', op: 'goto', page: pB }] } });
  await req('PUT', `/api/button/1/${S(1, 0)}`, { label: '', action: { type: 'page', op: 'goto', page: pC } });   // posição 4 da placa (linha 1, coluna 0)
  await req('PUT', `/api/page/${pB}`, { apps: [{ name: 'Calculadora', bundle: 'com.apple.calculator' }] });   // nome que não existe em /Applications: resolve pelo bundle id
  const [iApp, iGoto, iMulti, iPlain] = [await raw(1), await raw(2), await raw(3), await raw(4)];
  const HAS_CALC = fs.existsSync('/System/Applications/Calculator.app');   // o ícone real só existe no macOS
  if (HAS_CALC) check(iApp.equals(iGoto), '"ir para" uma página com app vinculado usa o ícone desse app');
  if (HAS_CALC) check(iApp.equals(iMulti), 'sequência com um passo "abrir app" usa o ícone do app');
  check(!iApp.equals(iPlain), '"ir para" uma página sem app continua com o símbolo de página');
  const rv = (await deck()).buttons[2].img; await req('PUT', `/api/page/${pB}`, { apps: [] });
  check((await deck()).buttons[2].img > rv && !(await raw(2)).equals(iApp), 'ao desvincular o app o ícone volta ao símbolo e a placa relê a imagem');

  section('10. sem a faixa de status na placa');
  await set({ cols: 4, rows: 2, font: 12, status: false }); d = await deck();
  check(d.top === 5 && d.h === 112 && d.w === 73 && d.buttons.length === 8, 'sem faixa: botões começam em y=5 e ficam mais altos (73x112)', JSON.stringify({ top: d.top, w: d.w, h: d.h }));
  check((await req('GET', '/api/img/0.raw', undefined, BOARD)).len === 73 * 112 * 2, 'imagem acompanha o novo tamanho');
  await set({ cols: 2, rows: 2 }); d = await deck(); check(d.w === 152 && d.h === 112 && d.top === 5, '2x2 sem faixa: 152x112 (cabe nos buffers da placa: 152x112x2 bytes)');
  await set({ cols: 4, rows: 2, status: true }); d = await deck(); check(d.top === 36 && d.h === 96, 'religar a faixa volta ao layout anterior');

  section('11. arrastar na grade: mover para um lugar vazio e trocar dois botões');
  const sw = (a: number, b: number) => req('POST', `/api/swap/1/${a}/${b}`);
  const b2 = (await req('GET', '/api/config')).json.pages[0].buttons;   // botões atuais da página 1
  await req('PUT', '/api/button/1/0', { label: 'Alfa', action: { type: 'url', url: 'github.com' } });
  await req('PUT', '/api/button/1/1', { label: 'Beta', action: { type: 'app', app: 'Calculator', path: '/System/Applications/Calculator.app' } });
  await req('PUT', `/api/button/1/${S(1, 1)}`, { label: '', action: null, clearImage: true });
  const lbl = async () => (await req('GET', '/api/config')).json.pages[0].buttons.map((x: any) => x.label);
  const imgA = await raw(0), imgB = await raw(1);
  check((await sw(0, 1)).status === 200 && (await lbl()).slice(0, 2).join() === 'Beta,Alfa', 'trocar dois botões ocupados: os dois mudam de lugar');
  check((await raw(0)).equals(imgB) && (await raw(1)).equals(imgA), 'as imagens da placa acompanham a troca (sem imagem velha em cache)');
  check((await sw(1, S(1, 1))).status === 200 && (await lbl())[S(1, 1)] === 'Alfa' && (await lbl())[1] === '', 'mover para um lugar vazio: o botão vai e o antigo lugar fica vazio');
  check((await sw(S(1, 1), S(1, 1))).status === 400 && (await sw(0, 99)).status === 400 && (await req('POST', '/api/swap/99/0/1')).status === 400, 'posições iguais, fora da grade ou página inexistente: recusado');
  const dk = await deck(); check(dk.buttons[0].label === 'Beta' && dk.buttons[5].label === 'Alfa', 'a placa recebe a nova ordem');
  void b2;

  section('12. subpasta e "fechar aplicativo"');
  await set({ cols: 4, rows: 2, font: 12, status: true });
  const pagesOf = async () => (await req('GET', '/api/config')).json.pages as any[];
  const np2 = (await req('POST', '/api/page', { name: 'Outra' })).json.id as number;   // 2ª aba, para testar próxima/anterior
  const before = (await pagesOf()).length;
  check((await req('PUT', `/api/button/1/${S(1, 2)}`, { label: 'Trabalho', action: { type: 'folder' } })).status === 200, 'botão "Subpasta" salva');
  let pgs = await pagesOf(); const fold = pgs.find((x: any) => x.parent === 1);
  check(pgs.length === before + 1 && !!fold && fold.name === 'Trabalho', 'cria uma página oculta (parent = página do botão) com o título do botão', JSON.stringify(fold && { id: fold.id, name: fold.name, parent: fold.parent }));
  check(fold.buttons[0].label === 'Voltar' && fold.buttons[0].action.op === 'up', 'o 1º botão da pasta já é "Voltar" (sobe para a página de origem)');
  check(pgs.find((x: any) => x.id === 1).buttons[S(1, 2)].action.page === fold.id, 'o botão guarda o id da pasta');
  const pressP = await press(6); d = await deck();
  check(pressP.status === 200 && pressP.json.quiet === true && d.page === 'Trabalho' && d.buttons[0].label === 'Voltar', 'tocar no botão abre a pasta na placa (cabeçalho só com o nome, sem "1/2")', JSON.stringify({ page: d.page, quiet: pressP.json.quiet }));
  await press(0); d = await deck(); check(d.page.startsWith('Principal'), 'tocar em "Voltar" volta à página de origem', d.page);
  await req('PUT', '/api/button/1/1', { label: 'Prox', action: { type: 'page', op: 'next' } });
  await req('PUT', `/api/button/1/${S(1, 2)}`, { label: 'Trabalho', action: { type: 'folder', page: fold.id } });   // reenviar não cria outra pasta
  check((await pagesOf()).length === before + 1, 'salvar de novo o mesmo botão não duplica a pasta');
  await press(6); await press(0); await press(1); d = await deck();
  check(/\s2\/\d+$/.test(d.page) && !d.page.startsWith('Trabalho'), 'próxima página pula a subpasta (vai para a 2ª aba)', d.page);
  await req('POST', `/api/current/1`);
  check((await req('DELETE', `/api/page/${fold.id}`)).status === 400, 'a subpasta não pode ser apagada como página');
  check((await req('PUT', `/api/page/${fold.id}`, { autoBack: true })).status === 200 && (await pagesOf()).find((x: any) => x.id === fold.id).autoBack === true, 'opção "voltar automaticamente" é guardada na pasta');
  await req('PUT', `/api/button/${fold.id}/1`, { label: 'Vol', action: { type: 'media', key: 'volup' } });
  await press(6); d = await deck(); check(d.page === 'Trabalho', 'dentro da pasta');
  const pa = await press(1); d = await deck();
  check(pa.json.ok === true && d.page.startsWith('Principal'), 'com "voltar automaticamente", depois da ação volta à página de origem', d.page);
  await req('PUT', `/api/page/${fold.id}`, { autoBack: false }); await press(6); await press(1); d = await deck();
  check(d.page === 'Trabalho', 'sem a opção, continua na pasta depois da ação'); await press(0);
  check((await req('PUT', '/api/button/1/3', { label: '', action: { type: 'multi', mode: 'seq', keep: false, steps: [{ type: 'folder' }, { type: 'text', text: 'x' }] } })).status === 400, 'subpasta não pode ser passo de sequência');
  await req('PUT', `/api/button/1/${S(1, 2)}`, { label: '', action: null });
  pgs = await pagesOf(); check(!pgs.some((x: any) => x.parent !== undefined) && pgs.length === before, 'limpar o botão apaga a pasta e o conteúdo dela');
  // fechar aplicativo
  check((await req('PUT', `/api/button/1/${S(1, 1)}`, { label: '', action: { type: 'quitapp', app: '' } })).status === 400, 'fechar aplicativo sem escolher o app: recusado');
  const qa = await req('PUT', `/api/button/1/${S(1, 1)}`, { label: '', action: { type: 'quitapp', app: 'Calculator', path: '/System/Applications/Calculator.app' } });
  const qt = await req('POST', `/api/test/1/${S(1, 1)}`);
  check(qa.status === 200 && qt.json.ok === true, 'fechar aplicativo: salva e executa (dry-run)', JSON.stringify(qt.json));
  check((await req('PUT', `/api/button/1/${S(1, 0)}`, { label: '', action: { type: 'multi', mode: 'seq', keep: false, steps: [{ type: 'quitapp', app: 'Calculator', path: '' }, { type: 'url', url: 'github.com' }] } })).status === 200, 'fechar aplicativo funciona como passo de sequência');
  const qimg = await raw(5); check(qimg.length === 73 * 96 * 2, 'imagem do botão "fechar aplicativo" (ícone do app com selo)');
  void np2;

  srv.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); srv?.kill(); process.exit(1); });
