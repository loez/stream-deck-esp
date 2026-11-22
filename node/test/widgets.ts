// Teste dos botões Relógio/Clima e das configurações do modo autônomo (standalone.ts, weather.ts, widgets.ts), com um "Open-Meteo" falso. Porta 8845.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';
import { wmoInfo, weatherIcon, WEATHER_KINDS } from '../src/weather.ts';
import { mergeStandalone, DEFAULT } from '../src/standalone.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PORT = 8845, OM = 8946, TOKEN = 'tok-widgets-teste-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
let temp = 21, code = 2, ipFail = false, ipHits = 0; const omHits: string[] = [];
const om = http.createServer((req, res) => {
  if ((req.url ?? '').startsWith('/?fields=')) {   // geolocalização por IP (ipwho.is falso)
    ipHits++; res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(ipFail ? { success: false } : { success: true, city: 'Cidadela', region: 'Estado Tal', country: 'Brasil', latitude: -10.123456, longitude: -50.654321, timezone: { id: 'America/Sao_Paulo' } }));
  }
  omHits.push(req.url ?? '');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if ((req.url ?? '').startsWith('/v1/search')) return res.end(JSON.stringify({ results: [{ name: 'Goiânia', latitude: -16.68689, longitude: -49.26479, timezone: 'America/Sao_Paulo', admin1: 'Goiás', country: 'Brasil' }, { name: 'Goiana', latitude: -7.56, longitude: -35.0, timezone: 'America/Recife' }] }));
  res.end(JSON.stringify({ current: { temperature_2m: temp, weather_code: code, is_day: 1 } }));
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-wd-')), DATA = path.join(TMP, 'data');
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; raw: Buffer }> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length), 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => { const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const raw = Buffer.concat(ch); let j: any; try { j = JSON.parse(raw.toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode ?? 0, json: j, raw }); }); });
  r.on('error', reject); r.end(b);
});
let srv: ChildProcess;

async function main() {
  section('códigos do tempo e ícones');
  check(wmoInfo(0, true).kind === 'sun' && wmoInfo(0, false).kind === 'moon' && wmoInfo(2).kind === 'partly' && wmoInfo(3).kind === 'cloud' && wmoInfo(45).kind === 'fog' && wmoInfo(63).kind === 'rain' && wmoInfo(75).kind === 'snow' && wmoInfo(96).kind === 'storm', 'códigos WMO viram o ícone certo');
  check(WEATHER_KINDS.every((k) => { const c = weatherIcon(k, 48); return c.width === 48 && c.toBuffer('image/png').length > 100; }), 'os 8 ícones são desenhados (48x48)');

  section('configurações');
  const s1 = mergeStandalone(DEFAULT, { enabled: true, tz: 'America/Sao_Paulo', weather: { name: 'Goiânia', lat: -16.68689, lon: -49.26479, units: 'c' }, clock: { h24: false }, idleReturnS: 1, nightDim: { on: true, from: '23:30', pct: 120 } });
  check(s1.enabled && s1.tz === 'America/Sao_Paulo' && s1.weather?.lat === -16.687 && s1.clock.h24 === false && s1.idleReturnS === 5 && s1.nightDim.from === '23:30' && s1.nightDim.pct === 100, 'normaliza: coordenadas com 3 casas, tempo mínimo 5 s, brilho até 100%', JSON.stringify(s1));
  const bad = (p: Record<string, unknown>, re: RegExp) => { try { mergeStandalone(DEFAULT, p); return false; } catch (e) { return re.test((e as Error).message); } };
  check(bad({ tz: 'Marte/Olympus' }, /fuso/) && bad({ weather: { lat: 99, lon: 0 } }, /clima/) && bad({ page: 'x' }, /página/), 'fuso, coordenada e página inválidos são recusados');
  check(mergeStandalone(DEFAULT, { nightDim: { from: '25:99' } }).nightDim.from === DEFAULT.nightDim.from, 'horário inválido mantém o anterior');

  section('servidor');
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 });
  await new Promise<void>((r) => om.listen(OM, '127.0.0.1', r));
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_DRYRUN: '1', DECK_OPENMETEO: `http://127.0.0.1:${OM}`, DECK_OPENMETEO_GEO: `http://127.0.0.1:${OM}`, DECK_IPGEO: `http://127.0.0.1:${OM}` }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await req('GET', '/api/config')).status === 200) break; } catch { /* sobe */ } await sleep(250); }
  section('cidade pelo IP');
  let r = await req('GET', '/api/standalone');
  check(r.status === 200 && r.json.weather === null && r.json.locAuto === true, 'sem cidade escolhida: configuração inicial (locAuto ligado)');
  await sleep(1500);
  r = await req('GET', '/api/standalone');
  check(r.json.weather?.name === 'Cidadela' && r.json.weather.lat === -10.123 && r.json.weather.lon === -50.654 && r.json.weather.auto === true && r.json.weather.admin === undefined && ipHits === 1, 'ao consultar as configurações o servidor detecta a cidade pelo IP (coordenadas arredondadas, marcada como automática)', JSON.stringify(r.json.weather) + ' hits=' + ipHits);
  await req('GET', '/api/standalone'); await sleep(300);
  check(ipHits === 1, 'com cidade definida não consulta o serviço de novo');
  r = await req('POST', '/api/standalone', { weather: { name: 'Escolhida', lat: -16.687, lon: -49.265, units: 'c' } });
  check(r.json.weather.name === 'Escolhida' && !('auto' in r.json.weather) && r.json.locAuto === false, 'escolher a cidade à mão desliga a detecção automática');
  await req('POST', '/api/standalone', { weather: null }); await req('GET', '/api/standalone'); await sleep(600);
  r = await req('GET', '/api/standalone');
  check(r.json.weather === null && ipHits === 1, 'apagar a cidade não faz a detecção automática voltar a mexer');
  r = await req('POST', '/api/standalone/locate');
  check(r.status === 200 && r.json.weather?.name === 'Cidadela' && r.json.weather.auto === true && r.json.locAuto === true && ipHits === 2, 'botão "usar minha localização": força a detecção (e religa a automática)');
  ipFail = true; r = await req('POST', '/api/standalone/locate'); ipFail = false;
  check(r.status === 400 && /IP/.test(r.json.erro), 'serviço que falha: erro claro e a cidade atual é mantida', JSON.stringify(r.json));
  check((await req('POST', '/api/standalone/locate', undefined, { Origin: 'https://site.malicioso' })).status === 403, 'detecção pedida por outro site (Origin): 403');

  section('geocoding');
  r = await req('GET', '/api/standalone/geocode?q=goi');
  check(r.status === 200 && r.json.length === 2 && r.json[0].name === 'Goiânia' && r.json[0].lat === -16.687 && r.json[0].tz === 'America/Sao_Paulo', 'busca de cidade devolve nome, coordenadas e fuso', JSON.stringify(r.json?.[0]));
  check((await req('GET', '/api/standalone/geocode?q=g')).json.length === 0, 'busca curta demais não consulta (lista vazia)');
  check((await req('GET', '/api/standalone/geocode?q=goi', undefined, { Origin: 'https://site.malicioso' })).status === 403, 'busca de outro site é recusada (Origin)');
  r = await req('POST', '/api/standalone', { weather: { name: 'Goiânia', lat: -16.687, lon: -49.265, units: 'c' }, tz: 'America/Sao_Paulo', clock: { h24: true } });
  check(r.status === 200 && r.json.weather.name === 'Goiânia' && r.json.tz === 'America/Sao_Paulo', 'salvar local do clima e fuso');
  check((await req('POST', '/api/standalone', { tz: 'Marte/X' })).status === 400, 'configuração inválida: 400 com a razão');
  check(JSON.parse(fs.readFileSync(path.join(DATA, 'standalone.json'), 'utf8')).weather.name === 'Goiânia' && (process.platform === 'win32' || (fs.statSync(path.join(DATA, 'standalone.json')).mode & 0o077) === 0), 'standalone.json gravado (0600; o Windows não tem modo de arquivo)');
  const STR = (await req('GET', '/api/settings')).json.stride as number;
  const put = (slot: number, action: unknown) => req('PUT', `/api/button/1/${slot}`, { label: '', action });
  check((await put(0, { type: 'widget', kind: 'nada' })).status === 400, 'tipo de widget inválido é recusado');
  check((await put(0, { type: 'widget', kind: 'clock' })).status === 200 && (await put(1, { type: 'widget', kind: 'weather' })).status === 200, 'salvar Relógio e Clima');
  r = await req('POST', '/api/test/1/1');
  check(r.status === 200 && r.json.ok === true && omHits.some((u) => u.startsWith('/v1/forecast?latitude=-16.687&longitude=-49.265')), 'tocar no Clima busca a previsão na internet (Open-Meteo)', JSON.stringify(omHits));
  const p0 = await req('GET', '/api/preview/1/0.png'), p1 = await req('GET', '/api/preview/1/1.png');
  check(p0.status === 200 && p0.raw.subarray(1, 4).toString() === 'PNG' && p1.status === 200 && p1.raw.length > 500, 'as duas prévias são desenhadas (PNG)');
  const w1 = p1.raw;
  temp = 8; code = 63; await req('POST', '/api/test/1/1');
  const p1b = await req('GET', '/api/preview/1/1.png');
  check(!p1b.raw.equals(w1), 'o clima novo (8°, chuva) muda a imagem do botão');
  const st = (await req('GET', '/api/status')).json;
  check(st.pv['1:0'] !== undefined && st.pv['1:1'] !== undefined, 'a versão da prévia dos widgets aparece em /api/status (a página recarrega só essa prévia)', JSON.stringify(st.pv));
  const deck = (await req('GET', '/api/deck?cap=tiles', undefined, { 'X-Deck': TOKEN, 'User-Agent': 'StreamDeckESP/1' })).json;
  check(deck.buttons.length > 0 && !JSON.stringify(deck).includes(TOKEN), '/api/deck não vaza o token');
  void STR;
}
main().catch((e) => { console.error('ERRO NO TESTE:', e); fails.push('erro: ' + e); }).finally(() => {
  srv?.kill(); om.close(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + '='.repeat(60) + `\n${checks} verificações, ${fails.length} falha(s)`);
  if (fails.length) { for (const x of fails) console.log('  FALHA: ' + x); process.exit(1); }
  process.exit(0);
});
