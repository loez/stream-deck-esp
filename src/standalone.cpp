// Modo autônomo: armazenamento do perfil (LittleFS), fuso/NTP e clima. Ver include/standalone.h e docs/MODO-AUTONOMO.md.
#include "standalone.h"
#include <LittleFS.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <time.h>
#include <sys/time.h>
#include <esp_sntp.h>
#include "esp_heap_caps.h"

SaUi g_saUi = {}; volatile uint32_t g_saUiVer = 0;
uint8_t *g_saIcon[8] = {};
volatile int g_wTemp = 0, g_wKind = 0; volatile bool g_wValid = false; volatile uint32_t g_wVer = 0, g_wAt = 0;

static bool g_fsOk = false, g_have = false, g_ntp = false, g_tzSet = false;
static JsonDocument g_doc;                    // perfil atual (só o Core 0 mexe)
static char g_rev[16] = "";
static const char *KINDS[8] = {"sun", "moon", "partly", "cloud", "fog", "rain", "storm", "snow"};
#define PROFILE "/sa/profile.json"

bool saInit() {
  g_fsOk = LittleFS.begin(true, "/littlefs", 8, "spiffs");   // true: formata a partição se não montar (conteúdo antigo de um firmware de rádio, sem uso)
  if (!g_fsOk) { Serial.println("[sa] LittleFS nao montou"); return false; }
  LittleFS.mkdir("/sa"); LittleFS.mkdir("/sa/img"); LittleFS.mkdir("/sa/icon");
  Serial.printf("[sa] LittleFS ok (%u KB usados de %u KB)\n", (unsigned)(LittleFS.usedBytes() / 1024), (unsigned)(LittleFS.totalBytes() / 1024));
  return true;
}
bool saHave() { return g_have; }
const char *saRev() { return g_rev; }
JsonObjectConst saProfile() { return g_doc.as<JsonObjectConst>(); }

bool saWriteFile(const char *path, const uint8_t *data, size_t n) {
  if (!g_fsOk) return false;
  File f = LittleFS.open(path, "w"); if (!f) return false;
  size_t w = f.write(data, n); f.close(); return w == n;
}
bool saReadFile(const char *path, uint8_t *dst, size_t cap, size_t *got) {
  if (!g_fsOk) return false;
  File f = LittleFS.open(path, "r"); if (!f) return false;
  size_t sz = f.size(); if (sz > cap) { f.close(); return false; }
  size_t r = f.read(dst, sz); f.close(); if (got) *got = r; return r == sz;
}
bool saCommitProfile(const uint8_t *json, size_t n) {
  if (!saWriteFile("/sa/profile.new", json, n)) return false;
  LittleFS.remove(PROFILE);
  return LittleFS.rename("/sa/profile.new", PROFILE);
}
void saClear() {
  if (!g_fsOk) return;
  for (const char *d : {"/sa/img", "/sa/icon", "/sa"}) {
    File dir = LittleFS.open(d); if (!dir || !dir.isDirectory()) continue;
    String names[40]; int n = 0; for (File e = dir.openNextFile(); e && n < 40; e = dir.openNextFile()) if (!e.isDirectory()) names[n++] = String(d) + "/" + e.name();
    dir.close(); for (int i = 0; i < n; i++) LittleFS.remove(names[i]);
  }
  g_have = false; g_rev[0] = 0; g_doc.clear(); g_wValid = false; g_saUiVer++;
  for (int i = 0; i < 8; i++) { heap_caps_free(g_saIcon[i]); g_saIcon[i] = nullptr; }
  Serial.println("[sa] perfil apagado");
}

static int minutes(const char *hhmm) { return (hhmm && strlen(hhmm) >= 5) ? atoi(hhmm) * 60 + atoi(hhmm + 3) : 0; }
bool saLoadProfile() {
  if (!g_fsOk) return false;
  File f = LittleFS.open(PROFILE, "r"); if (!f) { g_have = false; return false; }
  JsonDocument d; DeserializationError er = deserializeJson(d, f); f.close();
  if (er || !d["rev"].is<const char *>() || !d["tiles"].is<JsonArray>()) { Serial.printf("[sa] perfil invalido: %s\n", er.c_str()); g_have = false; return false; }
  g_doc = d; strlcpy(g_rev, g_doc["rev"] | "", sizeof g_rev); g_have = true;
  // fuso (POSIX TZ) para a hora local, mesmo sem Wi-Fi
  const char *tz = g_doc["tz"] | "UTC0"; setenv("TZ", tz, 1); tzset(); g_tzSet = true;
  // textos e opções para o Core 1
  SaUi u = {}; JsonObjectConst p = g_doc.as<JsonObjectConst>(), tx = p["tx"];
  u.h24 = p["clock"]["h24"] | true; u.seconds = p["clock"]["seconds"] | false; u.en = strcmp(p["lang"] | "pt", "en") == 0; u.idleS = p["idle"] | 20;
  u.night = p["night"]["on"] | false; u.nightFrom = minutes(p["night"]["from"] | "22:00"); u.nightTo = minutes(p["night"]["to"] | "06:00"); u.nightPct = p["night"]["pct"] | 15;
  u.weather = !p["weather"].isNull(); strlcpy(u.city, p["weather"]["name"] | "", sizeof u.city); u.units = (strcmp(p["weather"]["units"] | "c", "f") == 0) ? 'f' : 'c';
  strlcpy(u.tAuto, tx["auto"] | "Modo autonomo", sizeof u.tAuto); strlcpy(u.tTouch, tx["touch"] | "Toque para os botoes", sizeof u.tTouch); strlcpy(u.tNoData, tx["nodata"] | "sem dados", sizeof u.tNoData);
  for (int i = 0; i < 8; i++) strlcpy(u.kind[i], tx[KINDS[i]] | "", sizeof u.kind[i]);
  g_saUi = u; g_saUiVer++;
  // ícones do clima (48x48 RGB565) na PSRAM
  for (int i = 0; i < 8; i++) {
    char path[32]; snprintf(path, sizeof path, "/sa/icon/%s.raw", KINDS[i]); const size_t bytes = 48 * 48 * 2;
    if (!g_saIcon[i]) g_saIcon[i] = (uint8_t *)heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM);
    size_t got = 0; if (g_saIcon[i] && (!saReadFile(path, g_saIcon[i], bytes, &got) || got != bytes)) memset(g_saIcon[i], 0x18, bytes);
  }
  g_wVer++;   // o Core 1 redesenha
  Serial.printf("[sa] perfil %s carregado: %d botoes, fuso %s\n", g_rev, (int)p["tiles"].size(), tz);
  return true;
}

// ---------------- hora ----------------
static void onSync(struct timeval *) { g_ntp = true; }
void saTimeStart() {
  if (!g_have) return;
  sntp_set_time_sync_notification_cb(onSync);
  configTzTime(g_doc["tz"] | "UTC0", "pool.ntp.org", "time.google.com");
  Serial.println("[sa] NTP iniciado");
}
bool saTimeValid() { return time(nullptr) > 1700000000; }
void saTimeFromServer(uint32_t epoch) {
  if (g_ntp || epoch < 1700000000) return;                        // NTP manda; o servidor só acerta quando não há internet
  time_t now = time(nullptr); if (saTimeValid() && labs((long)(now - (time_t)epoch)) <= 2) return;
  struct timeval tv = {(time_t)epoch, 0}; settimeofday(&tv, nullptr);
  if (!g_tzSet && g_have) { setenv("TZ", g_doc["tz"] | "UTC0", 1); tzset(); g_tzSet = true; }
}

// ---------------- clima (Open-Meteo, HTTP puro) ----------------
static int kindOf(int code, bool day) {      // mesmo mapa do servidor (node/src/weather.ts: wmoInfo)
  if (code == 0 || code == 1) return day ? 0 : 1;
  if (code == 2) return 2; if (code == 3) return 3; if (code == 45 || code == 48) return 4;
  if ((code >= 51 && code <= 57) || (code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 5;
  if ((code >= 71 && code <= 77) || code == 85 || code == 86) return 7;
  if (code >= 95) return 6;
  return 3;
}
void saWeatherTick(bool wifiUp) {
  static uint32_t last = 0; static bool tried = false;
  if (!g_have || !wifiUp || g_doc["weather"].isNull()) return;
  const uint32_t every = g_wValid ? 20 * 60000UL : 60000UL;           // 20 min; sem leitura ainda: tenta a cada minuto
  if (tried && millis() - last < every) return;
  tried = true; last = millis();
  char url[200]; snprintf(url, sizeof url, "http://api.open-meteo.com/v1/forecast?latitude=%.3f&longitude=%.3f&current=temperature_2m,weather_code,is_day&temperature_unit=%s&timezone=auto",
                          (double)(g_doc["weather"]["lat"] | 0.0), (double)(g_doc["weather"]["lon"] | 0.0), strcmp(g_doc["weather"]["units"] | "c", "f") == 0 ? "fahrenheit" : "celsius");
  HTTPClient http; http.useHTTP10(true); http.setConnectTimeout(3000); http.setTimeout(5000); http.setUserAgent("StreamDeckESP/1");   // HTTP/1.0: sem resposta em pedaços (chunked), que o getStream() cru não decodifica
  if (!http.begin(url)) { Serial.println("[sa] clima: url invalida"); return; }
  int code = http.GET();
  if (code == 200) {
    JsonDocument f; f["current"]["temperature_2m"] = true; f["current"]["weather_code"] = true; f["current"]["is_day"] = true;
    JsonDocument d; DeserializationError er = deserializeJson(d, http.getStream(), DeserializationOption::Filter(f));
    if (!er && d["current"]["temperature_2m"].is<float>()) {
      g_wTemp = (int)lroundf(d["current"]["temperature_2m"].as<float>()); g_wKind = kindOf(d["current"]["weather_code"] | 3, (d["current"]["is_day"] | 1) != 0);
      g_wAt = millis(); g_wValid = true; g_wVer++; Serial.printf("[sa] clima: %d graus, icone %d\n", (int)g_wTemp, (int)g_wKind);
    } else Serial.printf("[sa] clima: resposta ilegivel (%s)\n", er.c_str());
  } else Serial.printf("[sa] clima falhou (http %d)\n", code);
  http.end();
}
