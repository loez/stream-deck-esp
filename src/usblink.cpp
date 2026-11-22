// Ver include/usblink.h. Quadro = A5 5A | tipo | id (u16) | tamanho (u32) | xor dos 9 primeiros bytes | payload (tudo little-endian).
#include "usblink.h"
#include "freertos/semphr.h"

enum : uint8_t { T_REQ = 1, T_RES = 2, T_HELLO = 3, T_BEACON = 4, T_PROBE = 7 };
#define HDR_LEN 10
#define MAX_PAYLOAD (8u * 1024 * 1024)

// ---- bytes de texto (comandos de depuração), do rx task para o loop() ----
class CmdStream : public Stream {
  static const size_t N = 256; uint8_t b[N]; volatile size_t head = 0, tail = 0;
 public:
  int available() override { return (int)((head + N - tail) % N); }
  int read() override { if (head == tail) return -1; uint8_t c = b[tail]; tail = (tail + 1) % N; return c; }
  int peek() override { return head == tail ? -1 : b[tail]; }
  void flush() override {}
  size_t write(uint8_t) override { return 0; }
  void push(uint8_t c) { size_t n = (head + 1) % N; if (n != tail) { b[head] = c; head = n; } }
};
static CmdStream g_cmd;
Stream &usbCmd() { return g_cmd; }

static volatile uint32_t g_alive = 0, g_lastRx = 0;   // millis da última prova de vida do servidor (HELLO/RES) e do último byte recebido
bool usbActive() { uint32_t a = g_alive; return a && millis() - a < 5000; }

// ---- envio: um Serial.write por quadro (o HWCDC segura um mutex durante a chamada: não se mistura com os logs de outras tasks) ----
static void sendFrame(uint8_t type, uint16_t id, const uint8_t *payload, size_t len) {
  uint8_t buf[HDR_LEN + 320]; if (len > 320) return;
  buf[0] = 0xA5; buf[1] = 0x5A; buf[2] = type; buf[3] = id & 255; buf[4] = id >> 8; buf[5] = len & 255; buf[6] = (len >> 8) & 255; buf[7] = 0; buf[8] = 0;
  uint8_t x = 0; for (int i = 0; i < 9; i++) x ^= buf[i]; buf[9] = x;
  if (len) memcpy(buf + HDR_LEN, payload, len);
  Serial.write(buf, HDR_LEN + len);
}

// ---- pedido em andamento (um de cada vez) ----
static struct { volatile bool active; uint16_t id; uint8_t *hdr; size_t hdrLen; uint8_t *dst; size_t cap; uint8_t st[2]; volatile uint32_t body; volatile int status; } g_pend;
static SemaphoreHandle_t g_reqMux, g_doneSem; static uint16_t g_nextId = 1;

int usbRequest(uint8_t method, const char *path, uint8_t *hdr, size_t hdrLen, uint8_t *dst, size_t cap, size_t *bodyLen, uint32_t timeoutMs) {
  *bodyLen = 0; size_t pl = strlen(path); if (pl > 300) return -1;
  if (xSemaphoreTake(g_reqMux, pdMS_TO_TICKS(timeoutMs + 2000)) != pdTRUE) return -1;
  uint16_t id = g_nextId++; if (!id) id = g_nextId++;
  xSemaphoreTake(g_doneSem, 0);
  g_pend.id = id; g_pend.hdr = hdr; g_pend.hdrLen = hdrLen; g_pend.dst = dst; g_pend.cap = cap; g_pend.body = 0; g_pend.status = -1; g_pend.active = true;
  uint8_t p[1 + 301]; p[0] = method; memcpy(p + 1, path, pl);
  const uint32_t t0 = millis(); g_lastRx = t0;
  sendFrame(T_REQ, id, p, 1 + pl);
  bool done = false;
  while (!done) {
    if (xSemaphoreTake(g_doneSem, pdMS_TO_TICKS(100)) == pdTRUE) { done = true; break; }
    if (millis() - g_lastRx > timeoutMs || !usbActive()) break;   // nada chegou por timeoutMs, ou o servidor sumiu
  }
  g_pend.active = false;
  int code = done ? g_pend.status : -1; *bodyLen = g_pend.body;
  xSemaphoreGive(g_reqMux); return code;
}

// ---- leitura (única task que lê a serial) ----
enum { S_TEXT, S_M1, S_HDR, S_PAYLOAD };
static int st = S_TEXT, hn = 0; static uint8_t hdrb[HDR_LEN]; static uint32_t plen = 0, pgot = 0; static uint8_t ftype = 0; static uint16_t fid = 0; static bool matched = false;
static const char *NAME = "streamdeck-esp";

static void frameStart() { matched = ftype == T_RES && g_pend.active && fid == g_pend.id; if (matched) { g_pend.body = 0; } if (ftype == T_HELLO) g_alive = millis(); }
static void frameData(const uint8_t *p, size_t n, uint32_t off) {   // n bytes do payload a partir do deslocamento off
  if (!matched) return;
  g_alive = millis();
  while (n && off < 2) { g_pend.st[off++] = *p++; n--; }
  if (!n) return;
  size_t b = off - 2;   // posição no corpo
  if (b < g_pend.hdrLen) { size_t c = min(n, g_pend.hdrLen - b); memcpy(g_pend.hdr + b, p, c); p += c; n -= c; b += c; }
  if (n) { size_t di = b - g_pend.hdrLen; size_t c = di < g_pend.cap ? min(n, g_pend.cap - di) : 0; if (c) memcpy(g_pend.dst + di, p, c); }
}
static void frameEnd() {
  if (ftype == T_PROBE) { sendFrame(T_BEACON, 0, (const uint8_t *)NAME, strlen(NAME)); return; }
  if (matched && g_pend.active) { g_pend.status = plen >= 2 ? (g_pend.st[0] | (g_pend.st[1] << 8)) : -1; g_pend.body = plen >= 2 ? plen - 2 : 0; xSemaphoreGive(g_doneSem); }
  matched = false;
}
static void process(const uint8_t *d, size_t n) {
  size_t i = 0;
  while (i < n) {
    switch (st) {
      case S_TEXT: if (d[i] == 0xA5) { st = S_M1; i++; } else g_cmd.push(d[i++]); break;
      case S_M1: if (d[i] == 0x5A) { hdrb[0] = 0xA5; hdrb[1] = 0x5A; hn = 2; st = S_HDR; i++; } else { g_cmd.push(0xA5); st = S_TEXT; } break;
      case S_HDR:
        hdrb[hn++] = d[i++];
        if (hn == HDR_LEN) {
          uint8_t x = 0; for (int k = 0; k < 9; k++) x ^= hdrb[k];
          uint32_t len = hdrb[5] | (hdrb[6] << 8) | (hdrb[7] << 16) | ((uint32_t)hdrb[8] << 24);
          if (x == hdrb[9] && len <= MAX_PAYLOAD) { ftype = hdrb[2]; fid = hdrb[3] | (hdrb[4] << 8); plen = len; pgot = 0; frameStart(); if (!plen) { frameEnd(); st = S_TEXT; } else st = S_PAYLOAD; }
          else st = S_TEXT;   // cabeçalho inválido: descarta
        }
        break;
      case S_PAYLOAD: { size_t take = min((size_t)(n - i), (size_t)(plen - pgot)); frameData(d + i, take, pgot); pgot += take; i += take; if (pgot == plen) { frameEnd(); st = S_TEXT; } } break;
    }
  }
}
static void rxTask(void *) {
  static uint8_t buf[512];
  for (;;) {
    int n = Serial.available();
    if (n <= 0) { if (st != S_TEXT && millis() - g_lastRx > 1000) { st = S_TEXT; matched = false; } vTaskDelay(1); continue; }   // quadro interrompido (cabo solto no meio): recomeça
    size_t r = Serial.read(buf, min(n, 512)); if (!r) continue;
    g_lastRx = millis(); process(buf, r);
  }
}
void usbLinkInit() {
  g_reqMux = xSemaphoreCreateMutex(); g_doneSem = xSemaphoreCreateBinary();
  xTaskCreatePinnedToCore(rxTask, "usbrx", 4096, NULL, 4, NULL, 0);
}
