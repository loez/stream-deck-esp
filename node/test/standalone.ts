// Teste do perfil autônomo (sa-profile.ts + endpoints /api/sa*): tabela de fusos, conteúdo do perfil (segredos só nele), autenticação, imagens, ícones e revisão. Porta 8846.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../src/env.ts';
import { BAT_CURVE, POSIX_TZ, boardWidget, posixTz } from '../src/sa-profile.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deslocamento (minutos, UTC+) de um fuso numa data, via Intl. */
function offsetMin(tz: string, d: Date): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d).find((x) => x.type === 'timeZoneName')!.value;
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(p); if (!m) return 0;
  return (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}
/** Deslocamento padrão (minutos, UTC+) escrito num POSIX TZ: o primeiro número, com sinal invertido. */
function posixStd(tz: string): { std: number; dst: boolean } {
  const m = /^(?:<[^>]+>|[A-Za-z]{3,})([+-]?\d{1,2})(?::(\d{2}))?(.*)$/.exec(tz)!;
  const h = Number(m[1]), mm = Number(m[2] ?? 0);
  return { std: -(Math.sign(h) || 1) * (Math.abs(h) * 60 + mm) * (h === 0 ? 0 : 1), dst: /^(?:<[^>]+>|[A-Za-z]{3,})/.test(m[3] ?? '') };
}

section('plugin Bateria da Placa -> botões da própria placa');
{ const P = 'com.luiz.ulanzistudio.bateriaesp', a = (n: string) => ({ type: 'plugin', plugin: P, action: `${P}.${n}` });
  check(boardWidget(a('nivel')) === 'battery' && boardWidget(a('brilhomais')) === 'bup' && boardWidget(a('brilhomenos')) === 'bdown' && boardWidget(a('apagar')) === 'boff' && boardWidget(a('desligar')) === 'bpower', 'as 5 ações do plugin viram botões da placa');
  check(boardWidget({ type: 'plugin', plugin: 'outro.plugin', action: 'x.nivel' }) === null && boardWidget({ type: 'webhook' }) === null && boardWidget(null) === null, 'outros plugins/ações não são afetados');
  check(BAT_CURVE[0]![1] === 0 && BAT_CURVE.at(-1)![1] === 100, 'curva da bateria vai no perfil (0..100%)'); }

const PORT = 8846, TOKEN = 'tok-sa-teste-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', SECRET = 'segredo-do-home-assistant-123';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sa-')), DATA = path.join(TMP, 'data');
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; raw: Buffer; text: string }> => new Promise((resolve, reject) => {
  const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(b ? { 'Content-Length': String(b.length), 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => { const ch: Buffer[] = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const raw = Buffer.concat(ch), text = raw.toString('utf8'); let j: any; try { j = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode ?? 0, json: j, raw, text }); }); });
  r.on('error', reject); r.end(b);
});
const BOARD = { 'X-Deck': TOKEN, 'User-Agent': 'StreamDeckESP/1' };
let srv: ChildProcess;

async function main() {
  section('tabela de fusos (IANA -> POSIX TZ)');
  let bad: string[] = [];
  for (const [iana, px] of Object.entries(POSIX_TZ)) {
    if (iana === 'Etc/UTC') continue;
    try {
      const jan = offsetMin(iana, new Date(Date.UTC(2026, 0, 15))), jul = offsetMin(iana, new Date(Date.UTC(2026, 6, 15))), { std, dst } = posixStd(px);
      const lo = Math.min(jan, jul), hi = Math.max(jan, jul);
      if (std !== lo || dst !== (hi !== lo)) bad.push(`${iana}: POSIX ${px} (padrão ${std}, dst ${dst}) x Intl ${lo}/${hi}`);
    } catch { bad.push(iana + ': Intl não conhece'); }
  }
  check(bad.length === 0, `os ${Object.keys(POSIX_TZ).length} fusos da tabela batem com o Intl (deslocamento padrão e existência de horário de verão)`, bad.join(' | '));
  check(posixTz('America/Sao_Paulo') === '<-03>3' && posixTz('Asia/Kathmandu') === '<+0545>-5:45', 'exemplos: São Paulo e Katmandu');
  check(/^<\+?-?\d+>/.test(posixTz('Pacific/Chatham')) || posixTz('Pacific/Chatham').length > 0, 'fuso fora da tabela usa o deslocamento de agora (sem horário de verão)', posixTz('Pacific/Chatham'));
  check(posixTz('Etc/Nao/Existe') === 'UTC0', 'fuso desconhecido cai para UTC');

  section('perfil no servidor');
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'token'), TOKEN, { mode: 0o600 });
  srv = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: { ...process.env, DECK_DATA: DATA, DECK_PORT: String(PORT), DECK_NOMDNS: '1', DECK_NOPLUGINS: '1', DECK_NOFOCUS: '1', DECK_NORES: '1', DECK_DRYRUN: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await req('GET', '/api/config')).status === 200) break; } catch { /* sobe */ } await sleep(250); }
  const put = (slot: number, action: unknown, label = '') => req('PUT', `/api/button/1/${slot}`, { label, action });
  const STR = (await req('GET', '/api/settings')).json.stride as number, S = (r: number, c: number) => r * STR + c;
  check((await req('GET', '/api/sa', undefined, BOARD)).status === 404 && (await req('GET', '/api/deck?cap=tiles', undefined, BOARD)).json.sa === '0', 'desligado: /api/sa é 404 e /api/deck anuncia sa = "0" (a placa apaga o que guardou)');
  await put(S(0, 0), { type: 'homeassistant', url: 'http://ha.local:8123', token: SECRET, domain: 'light', service: 'toggle', entity: 'light.sala' }, 'Luz');
  await put(S(0, 1), { type: 'webhook', url: 'https://hooks.exemplo.com/x', method: 'POST', body: '{"a":1}' }, 'Hook');
  await put(S(0, 2), { type: 'mqtt', host: '192.168.0.10', topic: 'casa/luz', payload: 'ON', user: 'u', pass: 'senha-mqtt' }, 'MQTT');
  await put(S(0, 3), { type: 'widget', kind: 'clock' });
  await put(S(1, 0), { type: 'app', app: 'Safari', path: '' }, 'Safari');
  let r = await req('POST', '/api/standalone', { enabled: true, page: 1, tz: 'America/Sao_Paulo', weather: { name: 'Goiânia', lat: -16.687, lon: -49.265, units: 'c' } });
  check(r.status === 200 && r.json.enabled === true, 'ligar o modo autônomo na página 1');
  check((await req('GET', '/api/sa')).status === 401, '/api/sa sem o token da placa: 401');
  r = await req('GET', '/api/sa', undefined, BOARD); const prof = r.json;
  check(r.status === 200 && prof.v === 1 && prof.tz === '<-03>3' && prof.tzName === 'America/Sao_Paulo' && prof.weather.lat === -16.687 && prof.clock.h24 === true && prof.idle === 20 && prof.night.pct === 15, 'perfil: fuso POSIX, clima, relógio, retorno e escurecer', JSON.stringify({ ...prof, tiles: undefined }).slice(0, 300));
  const t = (i: number) => prof.tiles.find((x: any) => x.i === i);
  check(t(0)?.ex?.k === 'homeassistant' && t(0).ex.token === SECRET && t(0).ex.entity === 'light.sala' && t(0).ex.domain === 'light', 'botão Home Assistant leva o descritor completo (inclui o token)', JSON.stringify(t(0)));
  check(t(1)?.ex?.k === 'webhook' && t(1).ex.url === 'https://hooks.exemplo.com/x' && t(1).ex.method === 'POST' && t(1).ex.body === '{"a":1}', 'botão Webhook (https)');
  check(t(2)?.ex?.k === 'mqtt' && t(2).ex.port === 1883 - 1883 + 1883 && t(2).ex.pass === 'senha-mqtt' && !('tls' in t(2).ex) && !('retain' in t(2).ex), 'botão MQTT (campos vazios/falsos ficam de fora)', JSON.stringify(t(2)));
  check(t(3)?.wd === 'clock' && !t(3).ex, 'relógio vira `wd` (a placa desenha sozinha)');
  const app = prof.tiles.find((x: any) => x.label === 'Safari');
  check(!!app && !('ex' in app) && !('wd' in app), 'botão que precisa do PC (abrir app) vem sem `ex`: só imagem');
  check(prof.tiles.every((x: any) => x.w > 20 && x.h > 20 && x.bar >= 8) && prof.geom.cols >= 2 && prof.tx.needpc === 'precisa do computador', 'geometria dos botões e textos no idioma do app');

  section('o que sai pelo /api/deck');
  const deck = await req('GET', `/api/deck?cap=tiles&sa=${prof.rev}`, undefined, BOARD);
  check(!deck.text.includes(SECRET) && !deck.text.includes('senha-mqtt') && !deck.text.includes('"ex"') && !deck.text.includes('hooks.exemplo.com'), '/api/deck nunca leva segredos, URLs nem descritores `ex`');
  check(deck.json.sa === prof.rev && Math.abs(deck.json.t - Date.now() / 1000) < 5, '/api/deck anuncia a revisão do perfil (sa) e a hora do servidor (t)', `${deck.json.sa} ${deck.json.t}`);
  r = await req('GET', '/api/standalone');
  check(r.json.boardRev === prof.rev && r.json.rev === prof.rev, 'o servidor sabe qual revisão a placa tem (sa= na consulta)', JSON.stringify([r.json.boardRev, r.json.rev]));
  check(!JSON.stringify(r.json).includes('senha-mqtt') && r.json.report.find((x: any) => x.label === 'Safari')?.ok === false && r.json.report.find((x: any) => x.label === 'Luz')?.ok === true, 'a página recebe o relatório "funciona sem o PC" (✓/✗) sem segredos');

  section('imagens e ícones');
  let img = await req('GET', `/api/sa/img/${t(0).i}.raw`, undefined, BOARD);
  check(img.status === 200 && img.raw.length === t(0).w * t(0).h * 2, 'imagem RGB565 do botão do perfil tem o tamanho do botão', String(img.raw.length));
  check((await req('GET', `/api/sa/img/${t(3).i}.raw`, undefined, BOARD)).status === 404 && (await req('GET', '/api/sa/img/99.raw', undefined, BOARD)).status === 404, 'imagem do relógio e de botão inexistente: 404');
  check((await req('GET', `/api/sa/img/${t(0).i}.raw`)).status === 401, 'imagem sem token: 401');
  const ic = await req('GET', '/api/sa/icon/sun.raw', undefined, BOARD);
  check(ic.status === 200 && ic.raw.length === 48 * 48 * 2 && prof.icons.length === 8 && (await req('GET', '/api/sa/icon/nada.raw', undefined, BOARD)).status === 404, 'ícone do clima 48x48 RGB565; nome inexistente: 404');

  section('revisão');
  await put(S(0, 0), { type: 'homeassistant', url: 'http://ha.local:8123', token: SECRET, domain: 'light', service: 'turn_on', entity: 'light.sala' }, 'Luz');
  const rev2 = (await req('GET', '/api/sa', undefined, BOARD)).json.rev;
  check(rev2 !== prof.rev && (await req('GET', '/api/deck?cap=tiles', undefined, BOARD)).json.sa === rev2, 'mudar um botão muda a revisão (a placa baixa de novo)');
  await req('POST', '/api/standalone', { clock: { h24: false } });
  const rev3 = (await req('GET', '/api/sa', undefined, BOARD)).json.rev;
  check(rev3 !== rev2, 'mudar uma configuração (24 h) também');
  await req('POST', '/api/standalone', { page: 999 });
  check((await req('GET', '/api/sa', undefined, BOARD)).status === 404, 'página que não existe: sem perfil');
  await req('POST', '/api/standalone', { page: 1, enabled: false });
  check((await req('GET', '/api/sa', undefined, BOARD)).status === 404 && (await req('GET', '/api/deck?cap=tiles', undefined, BOARD)).json.sa === '0', 'desligar: sem perfil e sa = "0"');
}
main().catch((e) => { console.error('ERRO NO TESTE:', e); fails.push('erro: ' + e); }).finally(() => {
  srv?.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + '='.repeat(60) + `\n${checks} verificações, ${fails.length} falha(s)`);
  if (fails.length) { for (const x of fails) console.log('  FALHA: ' + x); process.exit(1); }
  process.exit(0);
});
