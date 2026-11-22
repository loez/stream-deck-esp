// Teste de instalação de plugins sem fricção: URL do GitHub (servidor GitHub falso), .zip enviado, atualização no lugar, proteção contra pedidos de outros sites e recarga ao salvar (pasta vinculada / modo desenvolvedor).
// Instância temporária na porta 8843 (plugins 3943), sem mDNS/USB; o "GitHub" é um servidor local (DECK_GH_CODELOAD).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';
import { parseGithubUrl } from '../src/plugin-install.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<boolean> | boolean, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

/** .zip mínimo (método "stored") com os arquivos dados (caminho -> conteúdo). */
function makeZip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const nb = Buffer.from(name), data = Buffer.from(content), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, data); central.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const manifest = (id: string, name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, name, version: '1.0.0', main: 'plugin/app.js', actions: [{ id: id + '.a', name: 'Ação', states: [] }], ...extra });
const pluginFiles = (prefix: string, id: string, name: string, code = 'setInterval(() => {}, 1000);') => ({ [`${prefix}plugin.json`]: manifest(id, name), [`${prefix}plugin/app.js`]: code });

const PORT = 8843, GH = 8944;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pi-')), DATA = path.join(TMP, 'data'), PLUG = path.join(TMP, 'plugins');
const repos: Record<string, Buffer> = {};
const ghHits: string[] = [];
const gh = http.createServer((req, res) => { ghHits.push(req.url ?? ''); const m = /^\/([^/]+)\/([^/]+)\/zip\/(.+)$/.exec(req.url ?? ''); const z = m && repos[`${m[1]}/${m[2]}`]; if (!z) { res.writeHead(404); return res.end('nope'); } res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': z.length }); res.end(z); });

const req = (method: string, p: string, body?: Buffer | string | object, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h: Record<string, string> = { ...(b ? { 'Content-Length': String(b.length) } : {}), ...(b && !Buffer.isBuffer(body) && typeof body === 'object' ? { 'Content-Type': 'application/json' } : {}), ...headers };
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (res) => { const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { let j: any; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode ?? 0, json: j }); }); });
  r.on('error', reject); r.end(b);
});
const plugins = async () => (await req('GET', '/api/plugins')).json;
const install = (url: string) => req('POST', '/api/plugins/install-url', { url });
let srv: ChildProcess;

async function main() {
  section('URL do GitHub');
  const g = parseGithubUrl('https://github.com/acme/meu-plugin');
  check(g.owner === 'acme' && g.repo === 'meu-plugin' && g.ref === null && g.sub === '', 'URL simples');
  check(parseGithubUrl('github.com/acme/meu-plugin.git').repo === 'meu-plugin' && parseGithubUrl('acme/meu-plugin').owner === 'acme', '.git, sem https e dono/repo');
  const t = parseGithubUrl('https://github.com/acme/mono/tree/v1.2/plugins/relogio.deckplugin');
  check(t.ref === 'v1.2' && t.sub === 'plugins/relogio.deckplugin', '/tree/<ramo>/<pasta>');
  for (const bad of ['https://gitlab.com/a/b', 'https://github.com/so-dono', 'https://github.com/a/b/blob/main/x.js', 'javascript:alert(1)', '']) {
    let ok = false; try { parseGithubUrl(bad); } catch { ok = true; } check(ok, `recusa "${bad}"`);
  }

  fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(PLUG, { recursive: true });
  await new Promise<void>((r) => gh.listen(GH, '127.0.0.1', r));
  repos['acme/meu-plugin'] = makeZip({ ...pluginFiles('meu-plugin-main/', 'com.acme.um', 'Plugin Um'), 'meu-plugin-main/README.md': 'oi' });
  repos['acme/mono'] = makeZip({ ...pluginFiles('mono-main/plugins/a.deckplugin/', 'com.acme.a', 'Plugin A'), ...pluginFiles('mono-main/plugins/b.deckplugin/', 'com.acme.b', 'Plugin B') });
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_PLUGIN_PORT: '3943', DECK_PLUGINS_DIR: PLUG, DECK_NOMDNS: '1', DECK_NOFOCUS: '1', DECK_NORES: '1', DECK_DRYRUN: '1', DECK_GH_CODELOAD: `http://127.0.0.1:${GH}` }, stdio: 'ignore' });
  check(await until(async () => { try { return (await req('GET', '/api/config')).status === 200; } catch { return false; } }, 15000), 'servidor de teste subiu');

  section('instalar pela URL');
  let r = await install('https://github.com/acme/meu-plugin');
  check(r.status === 200 && r.json.name === 'Plugin Um' && r.json.updated === false && r.json.source === 'github.com/acme/meu-plugin', 'repositório com o plugin na raiz (zip com pasta-raiz) instala', JSON.stringify(r.json));
  check(fs.existsSync(path.join(PLUG, r.json.dir, 'plugin', 'app.js')) && !fs.existsSync(path.join(PLUG, r.json.dir, '.git')), 'arquivos copiados para a pasta de plugins');
  check((await plugins()).plugins.some((p: any) => p.uuid === 'com.acme.um'), 'aparece na lista de plugins');
  check(ghHits[0] === '/acme/meu-plugin/zip/HEAD', 'sem ramo: baixa o HEAD (ramo padrão)', ghHits[0]);
  fs.writeFileSync(path.join(PLUG, r.json.dir, 'config.json'), '{"token":"segredo-local"}');
  repos['acme/meu-plugin'] = makeZip({ ...pluginFiles('meu-plugin-main/', 'com.acme.um', 'Plugin Um', 'setInterval(() => {}, 2000); // v2'), 'meu-plugin-main/config.json': '{"token":"do-repositorio"}' });
  r = await install('https://github.com/acme/meu-plugin/tree/main');
  check(r.status === 200 && r.json.updated === true, 'instalar de novo atualiza no lugar (mesmo id)', JSON.stringify(r.json));
  check(fs.readFileSync(path.join(PLUG, r.json.dir, 'plugin', 'app.js'), 'utf8').includes('// v2'), 'o código novo foi copiado por cima');
  check(JSON.parse(fs.readFileSync(path.join(PLUG, r.json.dir, 'config.json'), 'utf8')).token === 'segredo-local', 'a configuração local (config.json) é preservada na atualização');
  check(ghHits[1] === '/acme/meu-plugin/zip/main', 'com /tree/<ramo>: baixa esse ramo', ghHits[1]);
  r = await install('https://github.com/acme/mono');
  check(r.status === 400 && /2 plugins/.test(r.json.erro) && /a\.deckplugin/.test(r.json.erro), 'repositório com vários plugins: pede a pasta e lista as opções', r.json?.erro);
  r = await install('https://github.com/acme/mono/tree/main/plugins/b.deckplugin');
  check(r.status === 200 && r.json.name === 'Plugin B', 'URL de pasta (/tree/<ramo>/<pasta>) instala só aquele plugin', JSON.stringify(r.json));
  r = await install('https://github.com/acme/nao-existe');
  check(r.status === 400 && /não encontrado|privado/.test(r.json.erro), 'repositório inexistente/privado: mensagem clara', r.json?.erro);
  r = await install('https://gitlab.com/a/b');
  check(r.status === 400 && /github\.com/.test(r.json.erro), 'URL que não é do GitHub: recusada');

  section('.zip enviado (arrastar e soltar)');
  const z = makeZip(pluginFiles('', 'com.acme.zip', 'Plugin Zip'));
  r = await req('POST', '/api/plugins/upload', z, { 'Content-Type': 'application/zip' });
  check(r.status === 200 && r.json.name === 'Plugin Zip' && r.json.updated === false, '.zip com o plugin na raiz instala', JSON.stringify(r.json));
  r = await req('POST', '/api/plugins/upload', z, { 'Content-Type': 'application/zip' });
  check(r.status === 200 && r.json.updated === true, 'o mesmo .zip de novo atualiza');
  r = await req('POST', '/api/plugins/upload', Buffer.from('isto não é um zip'), { 'Content-Type': 'application/zip' });
  check(r.status === 400 && !!r.json.erro, '.zip inválido: recusado sem derrubar o servidor', r.json?.erro);
  const slip = makeZip({ '../fora.txt': 'x', 'plugin.json': manifest('com.acme.slip', 'Slip') });
  r = await req('POST', '/api/plugins/upload', slip, { 'Content-Type': 'application/zip' });
  check(r.status === 400 && !fs.existsSync(path.join(TMP, 'fora.txt')), '.zip com caminho "../" (zip slip): recusado');

  section('proteção contra outros sites (CSRF)');
  r = await req('POST', '/api/plugins/install-url', JSON.stringify({ url: 'acme/meu-plugin' }), { 'Content-Type': 'text/plain' });
  check(r.status === 400, 'JSON enviado como text/plain (formulário de outro site) é recusado');
  r = await req('POST', '/api/plugins/install-url', { url: 'acme/meu-plugin' }, { Origin: 'https://site-malicioso.example' });
  check(r.status === 403, 'pedido com Origin de outro site é recusado (403)');
  r = await req('POST', '/api/plugins/upload', z, { 'Content-Type': 'application/zip', Origin: 'https://site-malicioso.example' });
  check(r.status === 403, 'upload vindo de outro site é recusado (403)');
  r = await req('POST', '/api/plugins/install-url', { url: 'acme/meu-plugin' }, { Origin: `http://localhost:${PORT}` });
  check(r.status === 200, 'a própria página (Origin localhost) continua funcionando');

  section('recarregar ao salvar (desenvolvimento)');
  const SRC = path.join(TMP, 'meu-codigo'); fs.mkdirSync(path.join(SRC, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'plugin.json'), manifest('com.acme.um', 'Plugin Um')); fs.writeFileSync(path.join(SRC, 'plugin', 'app.js'), 'setInterval(() => {}, 3000); // dev1');
  r = await req('POST', '/api/plugins/dev', { uuid: 'com.acme.outro', link: SRC });
  check(r.status === 400, 'vincular a plugin que não existe: recusado');
  r = await req('POST', '/api/plugins/dev', { uuid: 'com.acme.a', link: SRC });
  check(r.status === 400 && /id diferente|outro plugin|não encontrado/.test(r.json.erro), 'pasta com outro plugin (id diferente): recusada', r.json?.erro);
  r = await req('POST', '/api/plugins/dev', { uuid: 'com.acme.um', link: SRC });
  check(r.status === 200 && r.json.links['com.acme.um'], 'vincular a pasta de código ao plugin instalado', JSON.stringify(r.json));
  const dirUm = (await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um').dir;
  check(fs.readFileSync(path.join(PLUG, dirUm, 'plugin', 'app.js'), 'utf8').includes('// dev1'), 'ao vincular, o código da pasta já é copiado');
  const at0 = (await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um').dev.reloadedAt;
  await sleep(300); fs.writeFileSync(path.join(SRC, 'plugin', 'app.js'), 'setInterval(() => {}, 3000); // dev2');
  check(await until(() => fs.readFileSync(path.join(PLUG, dirUm, 'plugin', 'app.js'), 'utf8').includes('// dev2'), 8000), 'salvar o arquivo na pasta vinculada copia para o plugin instalado sozinho');
  const pu = (await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um');
  check(pu.dev.reloadedAt > at0 && /recarregado/.test(pu.dev.reloadWhy) && pu.dev.linked === SRC || pu.dev.linked.endsWith('meu-codigo'), 'a tela de plugins informa a recarga e a pasta vinculada', JSON.stringify(pu.dev));
  fs.writeFileSync(path.join(SRC, 'plugin.json'), '{ quebrado');
  check(await until(async () => !!(await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um').dev.error, 8000), 'manifesto quebrado no meio da edição: mostra o erro e mantém a versão que roda');
  fs.writeFileSync(path.join(SRC, 'plugin.json'), manifest('com.acme.um', 'Plugin Um'));
  check(await until(async () => !(await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um').dev.error, 8000), 'consertou o manifesto: o erro some');
  r = await req('POST', '/api/plugins/dev', { uuid: 'com.acme.um', unlink: true });
  check(r.status === 200 && !r.json.links['com.acme.um'], 'desvincular');
  fs.writeFileSync(path.join(SRC, 'plugin', 'app.js'), 'setInterval(() => {}, 3000); // dev3'); await sleep(1500);
  check(!fs.readFileSync(path.join(PLUG, dirUm, 'plugin', 'app.js'), 'utf8').includes('// dev3'), 'depois de desvincular, salvar não copia mais');
  r = await req('POST', '/api/plugins/dev', { watch: true });
  check(r.status === 200 && r.json.watch === true, 'modo desenvolvedor ligado');
  const at1 = (await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um').dev.reloadedAt;
  await sleep(300); fs.writeFileSync(path.join(PLUG, dirUm, 'plugin', 'app.js'), 'setInterval(() => {}, 3000); // editado-na-instalada');
  check(await until(async () => (await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um').dev.reloadedAt > at1, 8000), 'editar direto a cópia instalada também recarrega só esse plugin');
  const at2 = (await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um').dev.reloadedAt;
  fs.writeFileSync(path.join(PLUG, dirUm, 'config.json'), '{"gravado":"pelo plugin"}'); await sleep(1500);
  check((await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um').dev.reloadedAt === at2, 'arquivo de estado do plugin (config.json) não dispara recarga (sem laço)');
  r = await req('POST', '/api/plugins/dev', { uuid: 'com.acme.um', reload: true });
  check(r.status === 200 && (await plugins()).plugins.find((p: any) => p.uuid === 'com.acme.um').dev.reloadedAt > at2, 'recarregar manualmente');
  await req('POST', '/api/plugins/dev', { watch: false });
}
main().catch((e) => { console.error('ERRO NO TESTE:', e); fails.push('erro: ' + e); }).finally(() => {
  srv?.kill(); gh.close(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + '='.repeat(60) + `\n${checks} verificações, ${fails.length} falha(s)`);
  if (fails.length) { for (const x of fails) console.log('  FALHA: ' + x); process.exit(1); }
});
