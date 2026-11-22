// Modo autônomo (sem o app/PC): perfil guardado na flash (LittleFS), hora (NTP/fuso), clima e execução de ações de rede (netexec.cpp). Documentação: docs/MODO-AUTONOMO.md.
// O perfil é montado pelo servidor (node/src/sa-profile.ts) e baixado por /api/sa: tem os botões da página escolhida (imagem pronta + descritor `ex` do que a placa executa sozinha).
// Threads: tudo aqui roda no Core 0 (netTask), exceto o que está marcado; o Core 1 (LVGL) só lê `g_saUi`/`g_saW` e a hora do sistema.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

// ---- armazenamento (LittleFS na partição "spiffs") ----
bool saInit();                                   // monta o LittleFS (formata a partição se não montar: o conteúdo antigo era de um firmware de rádio, sem uso)
bool saLoadProfile();                            // lê /sa/profile.json; define o fuso, os ícones e g_saUi; false se não há perfil
void saClear();                                  // apaga tudo de /sa e esquece o perfil
bool saHave();
const char *saRev();                             // revisão guardada ("" = nenhuma)
JsonObjectConst saProfile();                     // raiz do perfil (válido se saHave())
bool saWriteFile(const char *path, const uint8_t *data, size_t n);
bool saReadFile(const char *path, uint8_t *dst, size_t cap, size_t *got);
bool saCommitProfile(const uint8_t *json, size_t n);   // grava como /sa/profile.new e troca por /sa/profile.json (o perfil só vale depois do commit)

// ---- o que o Core 1 precisa para desenhar o relógio (copiado do perfil; ver g_saUiVer) ----
struct SaUi {
  bool h24, seconds, night, weather, en; int idleS, nightFrom, nightTo, nightPct; char units;   // night*: minutos desde 00:00 e brilho em %
  char city[40], tAuto[28], tTouch[40], tNoData[20], kind[8][24];                              // textos já no idioma do app (kind: descrição de cada ícone)
};
extern SaUi g_saUi; extern volatile uint32_t g_saUiVer;
extern uint8_t *g_saIcon[8];                    // ícones do clima 48x48 RGB565 (PSRAM), ordem: sun moon partly cloud fog rain storm snow
extern volatile int g_wTemp, g_wKind; extern volatile bool g_wValid; extern volatile uint32_t g_wVer, g_wAt;   // clima atual (g_wKind = índice do ícone)

// ---- hora e clima ----
void saTimeStart();                              // Wi-Fi no ar: NTP com o fuso do perfil (chamar uma vez por conexão)
void saTimeFromServer(uint32_t epoch);           // sem NTP: acerta pelo relógio do servidor
bool saTimeValid();
void saWeatherTick(bool wifiUp);                 // busca o clima de tempos em tempos (HTTP, Open-Meteo)

// ---- execução de ações de rede (netexec.cpp) ----
typedef void (*ExecDone)(int tile, bool ok);
void execSetCallback(ExecDone cb);
bool execStart(JsonObjectConst ex, int tile);    // webhook | homeassistant | mqtt; roda numa task com pilha na PSRAM; false se já há uma em andamento
