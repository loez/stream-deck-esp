// Teste de idiomas: tr()/padrões, cobertura das chaves da página, servidor trocando de idioma (/api/i18n, /api/settings lang, mensagens de erro e nomes padrão).
// Instância temporária na porta 8807, sem mDNS, sem plugins.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';
import { tr, setLang, trBody } from '../src/i18n.ts';
import { EN } from '../src/locales/en.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-i18n-')), DATA = path.join(TMP, 'data'), PORT = 8807;
let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
const req = (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: b ? { 'Content-Length': String(b.length) } : {} }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { let j: any; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode || 0, json: j }); });
  });
  r.on('error', reject); r.end(b);
});
let srv: ChildProcess;
function start(): Promise<void> {
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_DRYRUN: '1' } });
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  section('tr() e padrões');
  setLang('pt'); check(tr('Salvar') === 'Salvar' && tr('máximo de 3 páginas') === 'máximo de 3 páginas', 'em português nada muda');
  setLang('en');
  check(tr('Salvar') === 'Save', 'chave exata'); check(tr('Placa em {ip}', { ip: '1.2.3.4' }) === 'Board at 1.2.3.4', 'variáveis {nome}');
  check(tr('máximo de 12 páginas') === 'at most 12 pages', 'padrão com valor'); check(tr('texto sem tradução') === 'texto sem tradução', 'sem tradução: fica o original');
  check(JSON.stringify(trBody({ erro: 'pedido inválido', n: 1, lista: [{ why: 'sem aplicativo' }] })) === '{"erro":"invalid request","n":1,"lista":[{"why":"no app"}]}', 'trBody traduz só erro/msg/why/toast/message');
  setLang('pt');

  section('cobertura da página');
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const keys = new Set<string>();
  for (const m of html.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]!.replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\"/g, '"'));
  const missing = [...keys].filter((k) => !(k in EN));
  check(keys.size > 100 && !missing.length, `todas as ${keys.size} chaves t('...') da página têm tradução`, missing.join(' | '));
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',');
  const bad = Object.entries(EN).filter(([k, v]) => vars(k) !== vars(v));
  check(!bad.length, 'as variáveis {x} são as mesmas no original e na tradução', bad.map(([k]) => k).join(' | '));

  section('servidor');
  await start();
  let r = await req('GET', '/api/i18n');
  check(r.json.lang === 'pt' && r.json.auto === true && Object.keys(r.json.dict).length === 0, 'sem escolha: português, auto=true, dicionário vazio');
  check((await req('PUT', '/api/settings', { lang: 'xx' })).status === 400, 'idioma desconhecido é recusado');
  check((await req('PUT', '/api/settings', { lang: 'en' })).status === 200, 'escolher inglês');
  r = await req('GET', '/api/i18n'); check(r.json.lang === 'en' && r.json.auto === false && r.json.dict['Salvar'] === 'Save' && r.json.langs.en === 'English', 'dicionário em inglês');
  r = await req('GET', '/api/nada'); check(r.status === 404 && r.json.erro === 'not found', 'mensagem de erro em inglês', JSON.stringify(r.json));
  r = await req('PUT', '/api/settings', { cols: 99 }); check(r.status === 400 && /^columns: value between \d+ and \d+$/.test(r.json.erro), 'erro com valores traduzido por padrão', JSON.stringify(r.json));
  r = await req('PUT', '/api/button/1/0', { label: '', action: { type: 'url', url: '' } }); check(r.status === 400 && r.json.erro === 'type the website address', 'validação de ação em inglês', JSON.stringify(r.json));
  r = await req('POST', '/api/page', { name: '' }); const pgs = (await req('GET', '/api/config')).json.pages;
  check(r.status === 200 && pgs.some((p: any) => /^Page \d+$/.test(p.name)), 'nome padrão de página nova em inglês');
  srv.kill(); await new Promise((res) => srv.once('exit', res));
  await start();
  r = await req('GET', '/api/i18n'); check(r.json.lang === 'en' && (JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).lang === 'en'), 'a escolha persiste ao reiniciar (settings.json)');
  check((await req('PUT', '/api/settings', { lang: 'pt' })).status === 200 && (await req('GET', '/api/nada')).json.erro === 'não encontrado', 'voltar ao português');

  srv.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); srv?.kill(); process.exit(1); });
