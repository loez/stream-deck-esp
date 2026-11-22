// Portal de configuração do Wi-Fi (ver include/portal.h). Core 0 (netTask): AP temporário + servidor web + DNS "cativo" (o celular abre a página sozinho).
// RAM: o servidor, o DNS e a lista de redes só existem enquanto o portal está aberto (a RAM interna é o gargalo; ver docs/hardware/MEMORIA-RAM.md).
#include "portal.h"
#include "portal_page.h"
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <ArduinoJson.h>
#include <esp_random.h>

struct Net { char s[33]; int8_t r; bool open; };
static const int MAXNET = 24;
static const uint32_t AUTO_OPEN_MS = 20000;      // sem nunca conectar desde o boot: abre o portal
static const uint32_t TRY_MS = 20000;            // tempo para a placa conectar na rede escolhida
static const uint32_t CLOSE_AFTER_OK_MS = 12000; // depois de conectar, a página ainda mostra o resultado
static const uint32_t IDLE_CLOSE_MS = 15 * 60000UL;

static WebServer *srv = nullptr;
static DNSServer *dns = nullptr;
static Net *nets = nullptr; static int nNets = 0;
static char apSsid[24], apPass[12];
static PortalView view = {};                      // lido pelo Core 1 (protegido por mux)
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static volatile bool g_force = false, g_dismiss = false;
static bool dismissed = false, forced = false;
enum { C_IDLE, C_TRY, C_OK, C_FAIL };
static int conn = C_IDLE;
static char pSsid[33], pPass[65]; static volatile bool pend = false;
static uint32_t bootT = millis(), tryT0 = 0, okAt = 0, lastAct = 0;

void portalForce() { g_force = true; }
void portalDismiss() { g_dismiss = true; }
bool portalActive() { return srv != nullptr; }
bool portalView(PortalView *v) {
  bool ch; portENTER_CRITICAL(&mux); ch = v->rev != view.rev; if (ch) *v = view; portEXIT_CRITICAL(&mux); return ch;
}
static void setMsg(const char *m) { portENTER_CRITICAL(&mux); strlcpy(view.msg, m, sizeof view.msg); view.rev++; portEXIT_CRITICAL(&mux); }

static bool utf8Ok(const char *s) {   // nome de rede fora do UTF-8 quebraria o JSON da página
  const uint8_t *p = (const uint8_t *)s;
  while (*p) {
    int n = *p < 0x80 ? 0 : (*p >> 5) == 6 ? 1 : (*p >> 4) == 14 ? 2 : (*p >> 3) == 30 ? 3 : -1;
    if (n < 0) return false; p++;
    while (n--) { if ((*p & 0xC0) != 0x80) return false; p++; }
  }
  return true;
}

static void scanNets() {   // bloqueante (~3 s); redes ocultas (sem nome) não aparecem
  nNets = 0;
  int n = WiFi.scanNetworks(false, false);
  for (int i = 0; i < n; i++) {
    String s = WiFi.SSID(i); if (!s.length() || s.length() > 32 || !utf8Ok(s.c_str())) continue;
    int8_t r = WiFi.RSSI(i); int k = -1;
    for (int j = 0; j < nNets; j++) if (s == nets[j].s) { k = j; break; }
    if (k >= 0) { if (r > nets[k].r) nets[k].r = r; continue; }   // mesma rede em vários roteadores/canais: fica o sinal mais forte
    if (nNets < MAXNET) { strlcpy(nets[nNets].s, s.c_str(), sizeof nets[0].s); nets[nNets].r = r; nets[nNets].open = WiFi.encryptionType(i) == WIFI_AUTH_OPEN; nNets++; }
  }
  WiFi.scanDelete();
  for (int a = 1; a < nNets; a++) { Net t = nets[a]; int b = a - 1; while (b >= 0 && nets[b].r < t.r) { nets[b + 1] = nets[b]; b--; } nets[b + 1] = t; }   // mais forte primeiro
  Serial.printf("[portal] %d rede(s) encontrada(s)\n", nNets);
}

static void sendJson(int code, JsonDocument &d) { String s; serializeJson(d, s); srv->sendHeader("Cache-Control", "no-store"); srv->send(code, "application/json", s); }

static void routes() {
  srv->on("/", HTTP_GET, []() { lastAct = millis(); srv->sendHeader("Cache-Control", "no-store"); srv->send_P(200, "text/html; charset=utf-8", PORTAL_PAGE); });
  srv->on("/api/scan", HTTP_GET, []() {   // sem ?fresh=1 devolve a lista de quando o portal abriu (instantânea); com ?fresh=1 busca de novo
    lastAct = millis(); if (srv->hasArg("fresh")) scanNets();
    JsonDocument d; JsonArray a = d.to<JsonArray>();
    for (int i = 0; i < nNets; i++) { JsonObject o = a.add<JsonObject>(); o["s"] = nets[i].s; o["r"] = nets[i].r; if (nets[i].open) o["o"] = 1; }
    sendJson(200, d);
  });
  srv->on("/api/status", HTTP_GET, []() {
    lastAct = millis(); JsonDocument d;
    d["state"] = conn == C_TRY ? "trying" : conn == C_OK ? "ok" : conn == C_FAIL ? "fail" : "idle";
    sendJson(200, d);
  });
  srv->on("/api/wifi", HTTP_POST, []() {
    lastAct = millis(); String s = srv->arg("ssid"), p = srv->arg("pass"); JsonDocument d;
    if (!s.length() || s.length() > 32 || p.length() > 63 || (p.length() && p.length() < 8) || conn == C_TRY) { d["ok"] = false; sendJson(400, d); return; }
    strlcpy(pSsid, s.c_str(), sizeof pSsid); strlcpy(pPass, p.c_str(), sizeof pPass); pend = true;   // a netTask aplica (fora desta chamada)
    Serial.println("[portal] rede escolhida pela pagina");
    d["ok"] = true; sendJson(200, d);
  });
  srv->onNotFound([]() { srv->sendHeader("Location", "http://192.168.4.1/"); srv->send(302, "text/plain", ""); });   // portal cativo: qualquer endereço leva à página
}

static void start(bool force, bool wifiUp) {
  Serial.println("[portal] abrindo");
  forced = force; conn = C_IDLE; pend = false; lastAct = millis();
  uint8_t m[6]; WiFi.macAddress(m); snprintf(apSsid, sizeof apSsid, "StreamDeck-%02X%02X", m[4], m[5]);
  static const char A[] = "abcdefghjkmnpqrstuvwxyz23456789";   // sem letras que se confundem (i, l, o, 0, 1)
  for (int i = 0; i < 8; i++) apPass[i] = A[esp_random() % (sizeof A - 1)]; apPass[8] = 0;
  if (!wifiUp) { WiFi.setAutoReconnect(false); WiFi.disconnect(false, false); delay(300); }   // o STA tentando conectar muda de canal e derrubaria o AP e a busca
  if (!nets) nets = (Net *)calloc(MAXNET, sizeof(Net));
  if (!nets) { Serial.println("[portal] sem memoria"); return; }
  scanNets();                                                   // antes de ligar o AP: o celular já encontra a lista pronta
  WiFi.mode(WIFI_AP_STA); WiFi.softAP(apSsid, apPass, 1, 0, 4);
  srv = new WebServer(80); routes(); srv->begin();
  dns = new DNSServer(); dns->start(53, "*", WiFi.softAPIP());
  portENTER_CRITICAL(&mux); view.on = true; strlcpy(view.ssid, apSsid, sizeof view.ssid); strlcpy(view.pass, apPass, sizeof view.pass); view.rev++; portEXIT_CRITICAL(&mux);
  setMsg("Aguardando o celular...");
}

static void stop() {
  Serial.println("[portal] fechando");
  if (srv) { srv->close(); delete srv; srv = nullptr; }
  if (dns) { dns->stop(); delete dns; dns = nullptr; }
  WiFi.softAPdisconnect(true); WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true);
  if (WiFi.status() != WL_CONNECTED) WiFi.begin();              // volta a tentar a rede gravada
  MDNS.end(); MDNS.begin("streamdeck-esp");                     // o mDNS precisa recomeçar depois da troca de modo
  free(nets); nets = nullptr; nNets = 0; forced = false; conn = C_IDLE; memset(pPass, 0, sizeof pPass);
  portENTER_CRITICAL(&mux); view.on = false; view.rev++; portEXIT_CRITICAL(&mux);
}

void portalTick(bool wifiUp, bool everUp) {
  if (!srv) {
    if (g_force) { g_force = false; g_dismiss = false; dismissed = false; start(true, wifiUp); return; }
    if (!everUp && !wifiUp && !dismissed && millis() - bootT > AUTO_OPEN_MS) start(false, wifiUp);
    return;
  }
  g_force = false;
  if (g_dismiss) { g_dismiss = false; dismissed = true; stop(); return; }
  srv->handleClient(); dns->processNextRequest();
  if (pend) {
    pend = false; conn = C_TRY; tryT0 = millis();
    char m[72]; snprintf(m, sizeof m, "Conectando a %.30s...", pSsid); setMsg(m);
    WiFi.disconnect(false, false); delay(300);                  // se já havia rede, sai dela antes (senão "conectado" apareceria antes da hora)
    WiFi.begin(pSsid, pPass);                                   // grava na NVS (WiFi.persistent) e conecta
    memset(pPass, 0, sizeof pPass);
    return;
  }
  if (conn == C_TRY) {
    if (wifiUp) { conn = C_OK; okAt = millis(); setMsg("Conectado! Pode fechar a pagina."); Serial.println("[portal] conectado"); }
    else if (millis() - tryT0 > TRY_MS) { conn = C_FAIL; WiFi.disconnect(false, false); setMsg("Nao conectou: confira a senha."); Serial.println("[portal] falhou ao conectar"); }
  } else if (conn == C_IDLE && wifiUp && !forced) { conn = C_OK; okAt = millis(); setMsg("Conectado!"); }   // a rede de antes voltou sozinha
  if (conn == C_OK && millis() - okAt > CLOSE_AFTER_OK_MS) { stop(); return; }
  if (millis() - lastAct > IDLE_CLOSE_MS) { dismissed = true; stop(); }                                    // ninguém usou: fecha (o AP não fica ligado para sempre)
}
