// Ações de casa inteligente executadas pelo servidor: webhook HTTP(S), Home Assistant (API REST) e MQTT (só publicar).
// O MESMO descritor (a ação do botão) também vai para a placa no "perfil autônomo" (standalone.ts), que a executa sozinha quando o PC está desligado.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import type { Result } from './actions.ts';

export const OFFLINE_TYPES = ['webhook', 'homeassistant', 'mqtt'];   // tipos que a placa executa sozinha (o resto precisa do computador)
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const httpUrl = (v: unknown, max: number, what: string): string => {
  let u = str(v, max); if (!u) throw new Error(`informe ${what}`);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'http://' + u;
  let p: URL; try { p = new URL(u); } catch { throw new Error(`${what} inválido`); }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error(`${what}: só http:// ou https://`);
  return u.replace(/\/+$/, '');
};

/** Valida e normaliza os campos de uma ação de rede (lança Error com a razão em português). Devolve só os campos conhecidos. */
export function cleanNet(type: string, A: Record<string, any>): Record<string, any> {
  if (type === 'webhook') {
    const o: Record<string, any> = { url: httpUrl(A.url, 500, 'o endereço do webhook'), method: METHODS.includes(String(A.method).toUpperCase()) ? String(A.method).toUpperCase() : 'GET' };
    const body = String(A.body ?? '').slice(0, 2000); if (body && o.method !== 'GET') { o.body = body; o.ctype = str(A.ctype, 100) || 'application/json'; }
    const hs = String(A.headers ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 8);
    for (const h of hs) if (!/^[A-Za-z0-9-]{1,40}:\s*[^\r\n]{0,300}$/.test(h)) throw new Error(`cabeçalho inválido: "${h.slice(0, 40)}" (use Nome: valor)`);
    if (hs.length) o.headers = hs.join('\n');
    return o;
  }
  if (type === 'homeassistant') {
    const o: Record<string, any> = { url: httpUrl(A.url, 200, 'o endereço do Home Assistant'), token: str(A.token, 600), domain: str(A.domain, 40), service: str(A.service, 60) };
    if (!o.token) throw new Error('informe o token de acesso do Home Assistant');
    if (!/^[a-z_]+$/.test(o.domain) || !/^[a-z_]+$/.test(o.service)) throw new Error('informe domínio e serviço (ex.: light e toggle)');
    const ent = str(A.entity, 120); if (ent) { if (!/^[a-z_]+\.[a-z0-9_]+$/.test(ent)) throw new Error('entidade inválida (ex.: light.sala)'); o.entity = ent; }
    const data = String(A.data ?? '').trim().slice(0, 1000);
    if (data) { try { const j = JSON.parse(data); if (!j || typeof j !== 'object' || Array.isArray(j)) throw 0; } catch { throw new Error('dados extras precisam ser um objeto JSON (ex.: {"brightness": 128})'); } o.data = data; }
    return o;
  }
  if (type === 'mqtt') {
    const host = str(A.host, 200); if (!host || /[\s/]/.test(host)) throw new Error('informe o endereço do broker MQTT');
    const port = Number(A.port ?? 1883); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('porta inválida');
    const topic = str(A.topic, 200); if (!topic || /[+#\0]/.test(topic)) throw new Error('informe o tópico (sem os curingas + e #)');
    const o: Record<string, any> = { host, port, topic, payload: String(A.payload ?? '').slice(0, 1000) };
    if (A.tls === true) o.tls = true;
    if (A.retain === true) o.retain = true;
    const user = str(A.user, 100), pass = str(A.pass, 200); if (user) { o.user = user; if (pass) o.pass = pass; }
    return o;
  }
  throw new Error('tipo de ação desconhecido');
}

const TIMEOUT = 6000;
const fail = (e: unknown): Result => {
  if (!(e instanceof Error)) return [false, 'erro'];
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return [false, 'sem resposta (tempo esgotado)'];
  const c = (e as any).cause; return [false, String(c?.code ?? c?.errors?.[0]?.code ?? c?.message ?? e.message).slice(0, 80)];   // o motivo real (ECONNREFUSED, ENOTFOUND...) vem na causa
};
async function call(method: string, url: string, headers: Record<string, string>, body?: string): Promise<Response> {
  return fetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
}
async function done(res: Response): Promise<Result> { try { await res.body?.cancel(); } catch { /* só o status importa */ } return res.ok ? [true, `HTTP ${res.status}`] : [false, `HTTP ${res.status}`]; }

export async function runWebhook(a: Record<string, any>): Promise<Result> {
  try {
    const h: Record<string, string> = { 'User-Agent': 'StreamDeckESP' };
    for (const l of String(a.headers ?? '').split('\n')) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
    if (a.body) h['Content-Type'] = String(a.ctype || 'application/json');
    return await done(await call(String(a.method || 'GET'), String(a.url), h, a.body ? String(a.body) : undefined));
  } catch (e) { return fail(e); }
}

export async function runHomeAssistant(a: Record<string, any>): Promise<Result> {
  try {
    const body: Record<string, unknown> = a.data ? JSON.parse(String(a.data)) : {};
    if (a.entity) body.entity_id = a.entity;
    return await done(await call('POST', `${a.url}/api/services/${a.domain}/${a.service}`, { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, JSON.stringify(body)));
  } catch (e) { return fail(e); }
}

/** Entidades do Home Assistant que fazem sentido num botão (luz, tomada, cena, script...), para a página listar. */
export async function haEntities(url: string, token: string): Promise<{ id: string; name: string }[]> {
  const base = httpUrl(url, 200, 'o endereço do Home Assistant');
  const res = await call('GET', base + '/api/states', { Authorization: `Bearer ${str(token, 600)}` });
  if (!res.ok) throw new Error(res.status === 401 ? 'token recusado pelo Home Assistant' : `Home Assistant respondeu HTTP ${res.status}`);
  const list = (await res.json()) as { entity_id?: string; attributes?: { friendly_name?: string } }[];
  const dom = new Set(['light', 'switch', 'scene', 'script', 'input_boolean', 'cover', 'fan', 'climate', 'lock', 'automation', 'media_player']);
  return list.filter((e) => e.entity_id && dom.has(e.entity_id.split('.')[0]!)).slice(0, 500).map((e) => ({ id: e.entity_id!, name: e.attributes?.friendly_name || e.entity_id! }));
}

// ---------- MQTT 3.1.1 mínimo: CONNECT, PUBLISH (QoS 0), DISCONNECT ----------
const lenBytes = (n: number): Buffer => { const b: number[] = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; b.push(d); } while (n > 0); return Buffer.from(b); };
const mqStr = (s: string): Buffer => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
export function mqttConnectPacket(clientId: string, user?: string, pass?: string): Buffer {
  const flags = 0x02 | (user ? 0x80 : 0) | (user && pass ? 0x40 : 0);
  const payload = Buffer.concat([mqStr(clientId), ...(user ? [mqStr(user)] : []), ...(user && pass ? [mqStr(pass)] : [])]);
  const vh = Buffer.concat([mqStr('MQTT'), Buffer.from([4, flags, 0, 10])]);
  return Buffer.concat([Buffer.from([0x10]), lenBytes(vh.length + payload.length), vh, payload]);
}
export function mqttPublishPacket(topic: string, payload: string, retain: boolean): Buffer {
  const body = Buffer.concat([mqStr(topic), Buffer.from(payload, 'utf8')]);
  return Buffer.concat([Buffer.from([0x30 | (retain ? 1 : 0)]), lenBytes(body.length), body]);
}
export function runMqtt(a: Record<string, any>): Promise<Result> {
  return new Promise((resolve) => {
    let settled = false, got = Buffer.alloc(0);
    const finish = (r: Result) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* já fechado */ } resolve(r); };
    const timer = setTimeout(() => finish([false, 'sem resposta do broker (tempo esgotado)']), TIMEOUT);
    const opts = { host: String(a.host), port: Number(a.port || 1883) };
    const hello = () => sock.write(mqttConnectPacket('deck-' + crypto.randomBytes(4).toString('hex'), a.user ? String(a.user) : undefined, a.pass ? String(a.pass) : undefined));
    const sock: net.Socket = a.tls ? tls.connect({ ...opts, servername: opts.host }, hello) : net.connect(opts, hello);
    sock.on('error', (e: NodeJS.ErrnoException) => finish([false, String(e.code ?? e.message).slice(0, 80)]));
    sock.on('data', (d) => {
      got = Buffer.concat([got, d as Buffer]); if (got.length < 4) return;
      if (got[0] !== 0x20 || got[3] !== 0) return finish([false, got[0] === 0x20 ? `broker recusou (código ${got[3]})` : 'resposta inesperada do broker']);
      sock.write(Buffer.concat([mqttPublishPacket(String(a.topic), String(a.payload ?? ''), !!a.retain), Buffer.from([0xe0, 0x00])]), () => finish([true, 'publicado']));
    });
  });
}
