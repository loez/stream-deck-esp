// Teste do backup (exportar/importar a configuração). Instância temporária na porta 8851, sem mDNS, sem plugins, em modo de teste (DRYRUN).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { PNG as PngLib } from 'pngjs';
import { ROOT } from '../src/env.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
const PORT = 8851, TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-bk-')), DATA = path.join(TMP, 'data');
const req = (method: string, p: string, body?: unknown, ctype = 'application/json'): Promise<{ status: number; json: any; text: string; headers: http.IncomingHttpHeaders }> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: b ? { 'Content-Length': String(b.length), 'Content-Type': ctype } : {} }, (res) => {
    const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const text = Buffer.concat(ch).toString('utf8'); let j: any; try { j = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode || 0, json: j, text, headers: res.headers }); });
  });
  r.on('error', reject); r.end(b);
});
let srv: ChildProcess;
const start = (): Promise<void> => {
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_DRYRUN: '1', DECK_NORES: '1' } });
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => req('GET', '/api/config').then(() => res(), () => (Date.now() - t0 > 15000 ? rej(new Error('servidor não subiu')) : setTimeout(tick, 200))); tick(); });
};

async function main() {
  await start();
  const im = new PngLib({ width: 8, height: 8 }); im.data.fill(200); const PNG = PngLib.sync.write(im);
  section('preparar a configuração');
  const ha = { type: 'homeassistant', url: 'http://ha.local:8123', token: 'SEGREDO-TOKEN', domain: 'light', service: 'toggle', entity: 'light.sala' };
  check((await req('PUT', '/api/button/1/0', { label: 'Luz', action: ha })).json?.ok === true, 'botão Home Assistant salvo');
  check((await req('PUT', '/api/button/1/1', { label: 'Atalho', action: { type: 'hotkey', keys: 'cmd+c' }, color: '#112233' })).json?.ok === true, 'botão com atalho e cor salvo');
  const up = await req('POST', '/api/button/1/2/image', PNG, 'image/png'); check(up.json?.ok === true, 'imagem enviada ao botão 3', JSON.stringify(up.json));
  const page2 = await req('POST', '/api/page', { name: 'Segunda' }); check(page2.status === 200, 'segunda página criada');

  section('exportar');
  const e0 = await req('GET', '/api/backup'), b0 = e0.json;
  check(e0.status === 200 && /attachment; filename="stream-deck-esp-backup-/.test(String(e0.headers['content-disposition'])), 'baixa como arquivo');
  check(b0.format === 'streamdeck-esp-backup' && b0.version === 1 && b0.config.pages.length === 2, 'formato e páginas');
  check(!e0.text.includes('SEGREDO-TOKEN') && b0.config.pages[0].buttons[0].action.token === undefined, 'sem segredos por padrão');
  check(b0.config.pages[0].buttons[0].action.entity === 'light.sala', 'o resto da ação fica');
  check(Object.keys(b0.files).length === 1 && b0.settings.screen === undefined, 'imagem incluída; tela da placa fora');
  const e1 = await req('GET', '/api/backup?secrets=1'); check(e1.json.config.pages[0].buttons[0].action.token === 'SEGREDO-TOKEN', 'com ?secrets=1 o token vai junto');

  section('importar');
  await req('PUT', '/api/button/1/0', { label: '', action: null }); await req('PUT', '/api/button/1/1', { label: 'X', action: null, color: null }); await req('DELETE', `/api/page/${page2.json.id ?? 2}`);
  check((await req('GET', '/api/config')).json.pages.length === 1, 'configuração alterada antes de importar');
  const imp = await req('POST', '/api/backup', e1.text); check(imp.json?.ok === true && imp.json.pages === 2, 'importação ok', JSON.stringify(imp.json));
  const c = (await req('GET', '/api/config')).json, bt = c.pages[0].buttons;
  check(c.pages.length === 2 && bt[0].label === 'Luz' && bt[0].action.token === 'SEGREDO-TOKEN' && bt[1].action.keys === 'cmd+c' && bt[1].color === '#112233', 'botões e páginas restaurados');
  check(!!bt[2].image && fs.existsSync(path.join(DATA, 'uploads', bt[2].image)), 'imagem restaurada no disco');
  check(fs.readdirSync(path.join(DATA, 'backups')).some((f) => f.startsWith('antes-da-importacao-')), 'cópia da configuração anterior guardada');
  check((await req('GET', `/api/preview/1/2.png`)).status === 200, 'a prévia do botão com imagem renderiza');

  section('recusas');
  check((await req('POST', '/api/backup', '{"format":"outro"}')).status === 400, 'arquivo de outro formato recusado');
  check((await req('POST', '/api/backup', 'isto não é json')).status === 400, 'lixo recusado');
  check((await req('POST', '/api/backup', e1.text, 'text/plain')).status === 400, 'tipo de conteúdo errado recusado (site de fora não importa)');
  const evil = JSON.parse(e1.text); evil.config.pages[0].buttons[1].action = { type: 'hotkey', keys: '' }; evil.config.pages[0].buttons[3] = { label: 'x', action: { type: 'ação-inexistente' } };
  check((await req('POST', '/api/backup', evil)).json?.ok === true && (await req('GET', '/api/config')).json.pages[0].buttons[3].action === null, 'ação inválida do arquivo é descartada (não executa nada estranho)');
}

main().then(() => { srv?.kill(); fs.rmSync(TMP, { recursive: true, force: true }); console.log(`\n${'='.repeat(60)}\n${checks} verificações, ${fails.length} falha(s)`); process.exit(fails.length ? 1 : 0); })
  .catch((e) => { srv?.kill(); console.error(e); process.exit(1); });
