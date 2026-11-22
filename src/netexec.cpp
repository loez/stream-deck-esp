// Execução de ações de rede pela própria placa (modo autônomo): webhook HTTP(S), Home Assistant (REST) e MQTT (só publicar). Ver include/standalone.h.
// Roda numa task própria com a pilha na PSRAM (TLS precisa de pilha grande; esta task NÃO grava NVS/flash). Política de TLS:
// domínio público => valida cadeia e nome com o bundle de raízes do framework; IP ou *.local (servidor local, geralmente autoassinado) => não valida.
// LIMITAÇÃO conhecida (mbedtls do pioarduino sem CONFIG_MBEDTLS_HAVE_TIME_DATE): a DATA de validade do certificado não é conferida.
#include "standalone.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "freertos/idf_additions.h"

static ExecDone g_cb = nullptr;
static volatile bool g_busy = false;
void execSetCallback(ExecDone cb) { g_cb = cb; }

struct Job {
  int tile; String k, url, method, body, ctype, headers, token, domain, service, entity, data, host, user, pass, topic, payload; uint16_t port = 1883; bool tls = false, retain = false;
};

static String hostOf(const String &url) {
  int s = url.indexOf("://"); String h = s >= 0 ? url.substring(s + 3) : url; int e = h.indexOf('/'); if (e >= 0) h.remove(e);
  int c = h.indexOf(':'); if (c >= 0) h.remove(c); return h;
}
static void tlsPolicy(WiFiClientSecure &cl, const String &host) {
  bool ip = host.length() > 0; for (size_t i = 0; i < host.length(); i++) if (!isdigit((unsigned char)host[i]) && host[i] != '.') ip = false;
  if (ip || host.endsWith(".local")) cl.setInsecure(); else cl.useBuiltinCACertBundle();
}

// Retorna o código HTTP (ou negativo em erro de conexão).
static int httpCall(const String &method, const String &url, const String &body, const String &ctype, const String &headers, const String &bearer) {
  WiFiClient plain; WiFiClientSecure tls; HTTPClient hc;
  const bool https = url.startsWith("https://");
  if (https) tlsPolicy(tls, hostOf(url));
  hc.setConnectTimeout(4000); hc.setTimeout(6000); hc.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS); hc.setUserAgent("StreamDeckESP/1");
  if (!(https ? hc.begin(tls, url) : hc.begin(plain, url))) return -100;
  if (bearer.length()) hc.addHeader("Authorization", "Bearer " + bearer);
  if (body.length()) hc.addHeader("Content-Type", ctype.length() ? ctype : "application/json");
  for (int p = 0; p < (int)headers.length();) {   // "Nome: valor" por linha
    int e = headers.indexOf('\n', p); if (e < 0) e = headers.length();
    String ln = headers.substring(p, e); int c = ln.indexOf(':'); if (c > 0) { String v = ln.substring(c + 1); v.trim(); hc.addHeader(ln.substring(0, c), v); }
    p = e + 1;
  }
  int code = hc.sendRequest(method.c_str(), (uint8_t *)body.c_str(), body.length());
  if (code > 0) hc.getString();   // lê a resposta (mantém a conexão limpa)
  hc.end();
  return code;
}

static void putLen(String &s, size_t n) { do { uint8_t d = n % 128; n /= 128; if (n) d |= 128; s += (char)d; } while (n); }
static void putStr(String &s, const String &v) { s += (char)(v.length() >> 8); s += (char)(v.length() & 255); s += v; }
static bool mqttPublish(const Job &j) {
  WiFiClient plain; WiFiClientSecure tls; WiFiClient &c = j.tls ? (WiFiClient &)tls : plain;
  if (j.tls) tlsPolicy(tls, j.host);
  c.setTimeout(4);   // segundos
  if (!c.connect(j.host.c_str(), j.port, 4000)) return false;
  String vh; putStr(vh, "MQTT"); vh += (char)4; vh += (char)(0x02 | (j.user.length() ? 0x80 : 0) | (j.user.length() && j.pass.length() ? 0x40 : 0)); vh += (char)0; vh += (char)10;
  String pl; char id[16]; snprintf(id, sizeof id, "deck-%04x", (unsigned)(esp_random() & 0xffff)); putStr(pl, id);
  if (j.user.length()) { putStr(pl, j.user); if (j.pass.length()) putStr(pl, j.pass); }
  String pk; pk += (char)0x10; putLen(pk, vh.length() + pl.length()); pk += vh; pk += pl;
  c.write((const uint8_t *)pk.c_str(), pk.length());
  uint8_t ack[4]; uint32_t t0 = millis(); size_t got = 0;
  while (got < 4 && millis() - t0 < 4000) { if (c.available()) ack[got++] = c.read(); else delay(5); }
  if (got < 4 || ack[0] != 0x20 || ack[3] != 0) { c.stop(); return false; }
  String body; putStr(body, j.topic); body += j.payload;
  String pub; pub += (char)(0x30 | (j.retain ? 1 : 0)); putLen(pub, body.length()); pub += body;
  bool ok = c.write((const uint8_t *)pub.c_str(), pub.length()) == pub.length();
  const uint8_t bye[2] = {0xE0, 0x00}; c.write(bye, 2); c.flush(); delay(30); c.stop();
  return ok;
}

static void execTask(void *p) {
  Job *j = (Job *)p; bool ok = false;
  if (WiFi.status() != WL_CONNECTED) Serial.println("[exec] sem Wi-Fi");
  else if (j->k == "webhook") { int c = httpCall(j->method.length() ? j->method : "GET", j->url, j->body, j->ctype, j->headers, ""); ok = c >= 200 && c < 300; Serial.printf("[exec] webhook -> http %d\n", c); }
  else if (j->k == "homeassistant") {
    JsonDocument d; if (j->data.length()) deserializeJson(d, j->data);
    if (j->entity.length()) d["entity_id"] = j->entity;
    String body; serializeJson(d, body);
    int c = httpCall("POST", j->url + "/api/services/" + j->domain + "/" + j->service, body, "application/json", "", j->token); ok = c >= 200 && c < 300; Serial.printf("[exec] home assistant %s.%s -> http %d\n", j->domain.c_str(), j->service.c_str(), c);   // o token nunca vai para o log
  } else if (j->k == "mqtt") { ok = mqttPublish(*j); Serial.printf("[exec] mqtt %s -> %s\n", j->topic.c_str(), ok ? "ok" : "falhou"); }
  if (g_cb) g_cb(j->tile, ok);
  delete j; g_busy = false;
  vTaskDeleteWithCaps(NULL);
}

bool execStart(JsonObjectConst ex, int tile) {
  if (g_busy) { Serial.println("[exec] ocupado"); return false; }
  const char *k = ex["k"] | ""; if (strcmp(k, "webhook") && strcmp(k, "homeassistant") && strcmp(k, "mqtt")) { Serial.printf("[exec] tipo desconhecido: %s\n", k); return false; }
  Job *j = new Job(); j->tile = tile; j->k = k;
  j->url = (const char *)(ex["url"] | ""); j->method = (const char *)(ex["method"] | "GET"); j->body = (const char *)(ex["body"] | ""); j->ctype = (const char *)(ex["ctype"] | ""); j->headers = (const char *)(ex["headers"] | "");
  j->token = (const char *)(ex["token"] | ""); j->domain = (const char *)(ex["domain"] | ""); j->service = (const char *)(ex["service"] | ""); j->entity = (const char *)(ex["entity"] | ""); j->data = (const char *)(ex["data"] | "");
  j->host = (const char *)(ex["host"] | ""); j->port = ex["port"] | 1883; j->tls = ex["tls"] | false; j->user = (const char *)(ex["user"] | ""); j->pass = (const char *)(ex["pass"] | "");
  j->topic = (const char *)(ex["topic"] | ""); j->payload = (const char *)(ex["payload"] | ""); j->retain = ex["retain"] | false;
  g_busy = true;
  if (xTaskCreatePinnedToCoreWithCaps(execTask, "exec", 16 * 1024, j, 1, NULL, 0, MALLOC_CAP_SPIRAM) != pdPASS) { Serial.println("[exec] nao criou a task"); g_busy = false; delete j; return false; }
  Serial.printf("[exec] %s iniciado\n", k);
  return true;
}
