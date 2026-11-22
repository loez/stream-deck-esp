// Teste das ações de casa inteligente (netactions.ts): validação, webhook, Home Assistant e MQTT contra servidores locais falsos (HTTP e um broker MQTT que confere os bytes).
import http from 'node:http';
import net from 'node:net';
import { cleanNet, runWebhook, runHomeAssistant, runMqtt, haEntities, mqttConnectPacket, mqttPublishPacket } from '../src/netactions.ts';
import { cleanAction, ValueError } from '../src/actions.ts';

let checks = 0; const fails: string[] = [];
const check = (ok: boolean, what: string, detail = '') => { checks++; if (ok) console.log(`  ✓ ${what}`); else { fails.push(what + ' ' + detail); console.log(`  ✗ ${what} ${detail}`); } };
const section = (t: string) => console.log(`\n== ${t}`);
const throws = (fn: () => unknown, re: RegExp) => { try { fn(); return false; } catch (e) { return re.test(e instanceof Error ? e.message : String(e)); } };

type Hit = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
const hits: Hit[] = [];
let status = 200;
const web = http.createServer((req, res) => {
  const ch: Buffer[] = []; req.on('data', (c) => ch.push(c));
  req.on('end', () => {
    hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(ch).toString('utf8') });
    if (req.url === '/api/states') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify([{ entity_id: 'light.sala', attributes: { friendly_name: 'Luz da sala' } }, { entity_id: 'sensor.temp', attributes: {} }, { entity_id: 'switch.tomada', attributes: {} }])); }
    if (req.headers.authorization !== 'Bearer tok-ok' && req.url?.startsWith('/api/')) { res.writeHead(401); return res.end('{}'); }
    res.writeHead(status); res.end('{}');
  });
});

// Broker MQTT de teste: confere CONNECT e PUBLISH e responde CONNACK
const mq: { connect?: Buffer; publish?: Buffer; refuse?: number } = {};
const broker = net.createServer((s) => {
  let buf = Buffer.alloc(0), stage = 0;
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d as Buffer]);
    if (stage === 0 && buf[0] === 0x10) { const len = buf[1]!; if (buf.length < 2 + len) return; mq.connect = Buffer.from(buf.subarray(0, 2 + len)); buf = buf.subarray(2 + len); stage = 1; s.write(Buffer.from([0x20, 0x02, 0x00, mq.refuse ?? 0])); }
    if (stage === 1 && buf.length && (buf[0]! & 0xf0) === 0x30) { const len = buf[1]!; if (buf.length < 2 + len) return; mq.publish = Buffer.from(buf.subarray(0, 2 + len)); }
  });
  s.on('error', () => {});
});

async function main() {
  await new Promise<void>((r) => web.listen(8951, '127.0.0.1', r));
  await new Promise<void>((r) => broker.listen(8952, '127.0.0.1', r));

  section('validação');
  let w = cleanNet('webhook', { url: 'exemplo.local/ligar', method: 'post', body: '{"a":1}', headers: 'X-Chave: abc\n\n Outro: 1 ' });
  check(w.url === 'http://exemplo.local/ligar' && w.method === 'POST' && w.body === '{"a":1}' && w.ctype === 'application/json' && w.headers === 'X-Chave: abc\nOutro: 1', 'webhook: endereço ganha http://, método em maiúsculas, corpo e cabeçalhos normalizados', JSON.stringify(w));
  check(!('body' in cleanNet('webhook', { url: 'http://a.b', method: 'GET', body: 'x' })), 'webhook GET não leva corpo');
  check(throws(() => cleanNet('webhook', { url: 'file:///etc/passwd' }), /só http/) && throws(() => cleanNet('webhook', { url: '' }), /informe/), 'webhook: file: e vazio são recusados');
  check(throws(() => cleanNet('webhook', { url: 'http://a.b', headers: 'sem dois pontos' }), /cabeçalho inválido/), 'webhook: cabeçalho fora do formato Nome: valor é recusado');
  const ha = cleanNet('homeassistant', { url: 'http://ha.local:8123/', token: ' t ', domain: 'light', service: 'toggle', entity: 'light.sala', data: '{"brightness":128}' });
  check(ha.url === 'http://ha.local:8123' && ha.token === 't' && ha.entity === 'light.sala' && ha.data === '{"brightness":128}', 'Home Assistant: normaliza endereço, token e entidade');
  check(throws(() => cleanNet('homeassistant', { url: 'http://x', token: '', domain: 'light', service: 'toggle' }), /token/) && throws(() => cleanNet('homeassistant', { url: 'http://x', token: 't', domain: 'Light!', service: 'toggle' }), /domínio/), 'Home Assistant: token vazio e domínio inválido são recusados');
  check(throws(() => cleanNet('homeassistant', { url: 'http://x', token: 't', domain: 'light', service: 'toggle', data: '[1]' }), /objeto JSON/) && throws(() => cleanNet('homeassistant', { url: 'http://x', token: 't', domain: 'light', service: 'toggle', entity: 'ruim' }), /entidade/), 'Home Assistant: dados que não são objeto e entidade mal formada são recusados');
  const m = cleanNet('mqtt', { host: '192.168.0.5', port: '1884', topic: 'casa/luz', payload: 'ON', retain: true, user: 'u', pass: 'p' });
  check(m.port === 1884 && m.retain === true && m.user === 'u' && m.pass === 'p' && !('tls' in m), 'MQTT: porta em número, retain e usuário/senha');
  check(throws(() => cleanNet('mqtt', { host: 'b', topic: 'casa/#' }), /curingas/) && throws(() => cleanNet('mqtt', { host: 'b', port: 70000, topic: 't' }), /porta/) && throws(() => cleanNet('mqtt', { host: '', topic: 't' }), /broker/), 'MQTT: curinga no tópico, porta absurda e broker vazio são recusados');
  check(cleanAction({ type: 'webhook', url: 'a.b/x' })?.url === 'http://a.b/x', 'cleanAction aceita o webhook');
  check((() => { try { cleanAction({ type: 'mqtt', host: 'b', topic: '' }); return false; } catch (e) { return e instanceof ValueError; } })(), 'cleanAction recusa com ValueError (mensagem para o usuário)');
  check((() => { try { cleanAction({ type: 'multi', mode: 'seq', steps: [{ type: 'webhook', url: 'a.b' }] }); return true; } catch { return false; } })() === false, 'webhook não entra como passo de sequência');

  section('webhook');
  hits.length = 0;
  let r = await runWebhook({ url: 'http://127.0.0.1:8951/ligar?x=1', method: 'POST', body: '{"on":true}', ctype: 'application/json', headers: 'X-Chave: abc' });
  check(r[0] && hits[0]?.method === 'POST' && hits[0].url === '/ligar?x=1' && hits[0].body === '{"on":true}' && hits[0].headers['x-chave'] === 'abc' && hits[0].headers['content-type'] === 'application/json', 'POST com corpo, tipo e cabeçalho personalizado', JSON.stringify(hits[0]));
  r = await runWebhook({ url: 'http://127.0.0.1:8951/x', method: 'GET' });
  check(r[0] && hits[1]?.method === 'GET' && hits[1].body === '', 'GET simples');
  status = 500; r = await runWebhook({ url: 'http://127.0.0.1:8951/x' }); status = 200;
  check(!r[0] && r[1] === 'HTTP 500', 'resposta de erro vira falha com o código', r[1]);
  r = await runWebhook({ url: 'http://127.0.0.1:8959/x' });
  check(!r[0] && /ECONNREFUSED/.test(r[1]), 'servidor fora do ar: falha com o motivo', r[1]);

  section('Home Assistant');
  hits.length = 0;
  r = await runHomeAssistant({ url: 'http://127.0.0.1:8951', token: 'tok-ok', domain: 'light', service: 'toggle', entity: 'light.sala', data: '{"brightness":128}' });
  check(r[0] && hits[0]?.method === 'POST' && hits[0].url === '/api/services/light/toggle' && hits[0].headers.authorization === 'Bearer tok-ok' && JSON.parse(hits[0].body).entity_id === 'light.sala' && JSON.parse(hits[0].body).brightness === 128, 'chama /api/services/<domínio>/<serviço> com Bearer e entity_id', JSON.stringify(hits[0]));
  r = await runHomeAssistant({ url: 'http://127.0.0.1:8951', token: 'errado', domain: 'light', service: 'toggle' });
  check(!r[0] && r[1] === 'HTTP 401', 'token errado: HTTP 401', r[1]);
  const ents = await haEntities('http://127.0.0.1:8951', 'tok-ok');
  check(ents.length === 2 && ents[0]!.name === 'Luz da sala' && !ents.some((e) => e.id.startsWith('sensor.')), 'lista só entidades acionáveis (luz, tomada...), com o nome amigável');

  section('MQTT');
  const pk = mqttConnectPacket('abc', 'u', 'p');
  check(pk[0] === 0x10 && pk.subarray(2, 8).equals(Buffer.from([0, 4, 0x4d, 0x51, 0x54, 0x54])) && pk[8] === 4 && pk[9] === 0xc2, 'CONNECT: MQTT nível 4, clean session, usuário e senha');
  const pp = mqttPublishPacket('a/b', 'ON', true);
  check(pp.equals(Buffer.from([0x31, 7, 0, 3, 0x61, 0x2f, 0x62, 0x4f, 0x4e])), 'PUBLISH QoS 0 com retain: bytes exatos', pp.toString('hex'));
  r = await runMqtt({ host: '127.0.0.1', port: 8952, topic: 'casa/luz', payload: 'ON', retain: false });
  await new Promise((x) => setTimeout(x, 100));
  check(r[0] && mq.publish?.subarray(0, 1)[0] === 0x30 && mq.publish.toString('latin1').includes('casa/luz') && mq.publish.toString('latin1').endsWith('ON'), 'publica no tópico com o payload', r[1]);
  check(!!mq.connect && mq.connect.subarray(2, 8).equals(Buffer.from([0, 4, 0x4d, 0x51, 0x54, 0x54])), 'o broker recebeu um CONNECT válido');
  mq.refuse = 5; r = await runMqtt({ host: '127.0.0.1', port: 8952, topic: 't', payload: 'x' }); mq.refuse = 0;
  check(!r[0] && /recusou/.test(r[1]), 'broker recusa (CONNACK != 0): falha com o código', r[1]);
  r = await runMqtt({ host: '127.0.0.1', port: 8959, topic: 't', payload: 'x' });
  check(!r[0] && /ECONNREFUSED/.test(r[1]), 'broker fora do ar: falha com o motivo', r[1]);
}
main().catch((e) => { console.error('ERRO NO TESTE:', e); fails.push('erro: ' + e); }).finally(() => {
  web.close(); broker.close();
  console.log('\n' + '='.repeat(60) + `\n${checks} verificações, ${fails.length} falha(s)`);
  if (fails.length) { for (const x of fails) console.log('  FALHA: ' + x); process.exit(1); }
  process.exit(0);
});
