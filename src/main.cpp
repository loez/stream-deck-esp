// Stream Deck de toque - LCDWiki ES3C28P. Grade de 2x2 a 4x4 (padrão 4x2) em paisagem (320x240), botões com imagem + rótulo; grade e fonte vêm do servidor.
// Core 1 (loopTask): LVGL + toque (I2C) + display SPI com DMA. Core 0 (netTask): Wi-Fi, descoberta do Mac por mDNS, HTTP.
// A placa acha o servidor do Mac (_streamdeck._tcp), baixa nomes/imagens (/api/deck, /api/img/N.raw) e avisa os toques (POST /api/press/N).
// O LVGL só é mexido pelo Core 1: a rede grava em buffers "pendentes" e o loop() aplica.
#include <Arduino.h>
#include <lvgl.h>
#include "src/misc/cache/instance/lv_image_cache.h"
#include "esp_heap_caps.h"
#include "esp_task_wdt.h"
#include "freertos/idf_additions.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "esp_wifi.h"
#include "montserrat_ttf.h"

SET_LOOP_TASK_STACK_SIZE(14 * 1024);

// TLS na PSRAM: cada sessão HTTPS usa ~50 KB de RAM interna (o gargalo); isto desvia as alocações do mbedtls (ver -Wl,--wrap no platformio.ini e docs/hardware/MEMORIA-RAM.md)
extern "C" void *__wrap_esp_mbedtls_mem_calloc(size_t n, size_t s) {
  void *p = heap_caps_calloc(n, s, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return p ? p : heap_caps_calloc(n, s, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

#include "board.h"
#include "usblink.h"
#include "standalone.h"
#include <time.h>
#include "portal.h"   // tudo que é da placa (pinos, painel, toque, backlight) vive em src/board_<nome>.cpp
#define SW (BOARD.w)
#define SH (BOARD.h)

static lv_display_t *g_disp;
static int g_bl = 0;
static void fadeBacklight(int to) {
  int step = to > g_bl ? 12 : -12;
  while (g_bl != to) { int n = g_bl + step; if ((step > 0 && n > to) || (step < 0 && n < to)) n = to; g_bl = n; boardBacklight(n); delay(8); }
}

static volatile uint32_t g_lastTouch = 0;   // millis do último toque (modo autônomo: volta ao relógio e escurece à noite)
static volatile int g_injX = -1, g_injY = -1; static volatile uint32_t g_injUntil = 0;   // toque virtual (serial: T x,y)
static volatile int g_blTarget = 255;                       // brilho pedido pelo servidor (Core 0 grava, Core 1 aplica)
static volatile bool g_powerOff = false;   // servidor pediu para desligar a placa (só o RESET volta)
static volatile bool g_scrOff = false, g_wokePend = false;  // tela apagada (pelo servidor ou por nós); acordou por toque e o servidor ainda não sabe
static void touch_cb(lv_indev_t *, lv_indev_data_t *d) {
  static int lx = 0, ly = 0; static bool swallow = false;
  int tx = 0, ty = 0; bool down = boardTouch(&tx, &ty);
  if (g_injUntil && millis() < g_injUntil) { down = true; tx = g_injX; ty = g_injY; }
  if (down) g_lastTouch = millis();
  if (down && g_scrOff) { g_scrOff = false; g_wokePend = true; swallow = true; }   // o toque que acorda a tela não aperta botão
  if (swallow) { if (down) { d->state = LV_INDEV_STATE_RELEASED; d->point.x = lx; d->point.y = ly; return; } swallow = false; }
  if (down) { lx = tx; ly = ty; d->state = LV_INDEV_STATE_PRESSED; } else d->state = LV_INDEV_STATE_RELEASED;
  d->point.x = lx; d->point.y = ly;
}

// ---------------- Estado compartilhado entre os núcleos ----------------
#define MAXCOLS 8
#define MAXROWS 6
#define MAXBTN (MAXCOLS * MAXROWS)      // 8x6: teto do formato (o que cabe de fato depende da tela: o servidor limita)
#define IMG_BUDGET (6 * 1024 * 1024)    // teto de PSRAM para as imagens (exibidas + recebidas)
enum { ST_SEARCH = 0, ST_OK = 1, ST_OFF = 2, ST_UNPAIRED = 3 };
static volatile int g_status = ST_SEARCH;
// Botões ("tiles"): o servidor manda a lista pronta em /api/deck, cada um com seu retângulo (um botão juntado é um tile maior). g_ui = o que está na tela (só o Core 1 mexe); g_net = o que o servidor mandou (só o Core 0 mexe)
#define MARGIN_X 5
#define GAP 6
struct Tile { int i, x, y, w, h, bar; uint8_t sl, slr; uint32_t slc; uint8_t wd; };   // wd: botão desenhado pela própria placa no modo autônomo (1 relógio, 2 clima)   // i = índice do botão na placa (linha*colunas + coluna do canto superior esquerdo); retângulo em pixels; altura da faixa do nome; sl = controle deslizante (0 não, 1 horizontal, 2 vertical), slr = relativo (sem preenchimento), slc = cor RGB
struct Geom { int cols, rows, font, top, n; Tile t[MAXBTN]; };   // font = fonte escolhida; top = y do 1º botão (36 com a faixa de status, 5 sem ela)
static void makeUniform(Geom &g, int cols, int rows, int w, int h, int bar, int font, int top) {   // grade uniforme (servidor sem botões juntados e estado inicial)
  memset(&g, 0, sizeof g); g.cols = cols; g.rows = rows; g.font = font; g.top = top; g.n = min(cols * rows, MAXBTN);
  for (int k = 0; k < g.n; k++) g.t[k] = {k, MARGIN_X + (k % cols) * (w + GAP), top + (k / cols) * (h + GAP), w, h, bar};
}
static bool sameGeom(const Geom &a, const Geom &b) {
  if (a.cols != b.cols || a.rows != b.rows || a.font != b.font || a.top != b.top || a.n != b.n) return false;
  for (int k = 0; k < a.n; k++) if (a.t[k].i != b.t[k].i || a.t[k].x != b.t[k].x || a.t[k].y != b.t[k].y || a.t[k].w != b.t[k].w || a.t[k].h != b.t[k].h || a.t[k].bar != b.t[k].bar || a.t[k].sl != b.t[k].sl || a.t[k].slr != b.t[k].slr || a.t[k].slc != b.t[k].slc || a.t[k].wd != b.t[k].wd) return false;
  return true;
}
static bool sameImgGeom(const Geom &a, const Geom &b) {   // o que as imagens baixadas dependem: quais botões e que tamanho (se muda, tudo é baixado de novo)
  if (a.n != b.n) return false;
  for (int k = 0; k < a.n; k++) if (a.t[k].i != b.t[k].i || a.t[k].w != b.t[k].w || a.t[k].h != b.t[k].h) return false;
  return true;
}
static Geom g_ui, g_net, g_pendGeom;
static inline size_t tileBytes(const Tile &t) { return (size_t)t.w * t.h * 2; }
static volatile bool g_geomReady, g_geomImgChg;   // o Core 0 avisa que a grade mudou; imgChg: os botões/tamanhos das imagens mudaram (as de antes não servem)
static uint8_t *g_img[MAXBTN];                 // imagem exibida de cada botão (PSRAM, alocadas para a lista atual) - só o Core 1 mexe
static uint8_t *g_pend[MAXBTN];                // imagens recebidas (PSRAM) - o Core 0 escreve, o Core 1 copia
static size_t g_imgBytes[MAXBTN];              // bytes de cada imagem alocada (largura x altura do botão x 2)
static SemaphoreHandle_t g_imgMux;             // protege g_pend: o Core 0 segura enquanto baixa uma imagem, o Core 1 enquanto refaz os buffers
static volatile uint32_t g_netGen = 0, g_uiGen = 0, g_pendGen = 0;   // geração da geometria: a rede só baixa imagens depois de o Core 1 ter refeito os buffers dela
static const uint16_t IMG_DARK = 0x18E4;       // fundo escuro (RGB565) até chegar a imagem real
// Animações (GIF): o servidor manda os quadros já no tamanho do botão (/api/anim/N.bin); a rede (Core 0) baixa e entrega ao Core 1, que troca o quadro de cada botão no tempo certo
#define ANIM_MAXF 32                            // quadros por botão (o servidor limita igual)
#define ANIM_BUDGET (3 * 1024 * 1024)           // teto de PSRAM para todos os quadros
struct Anim { int n = 0, cur = 0; uint32_t nextAt = 0; size_t bytes = 0; uint8_t *buf = nullptr; uint16_t delay[ANIM_MAXF]; };
static Anim g_anim[MAXBTN];                     // animações em exibição - só o Core 1 mexe
static uint8_t *g_animPend[MAXBTN]; static uint16_t g_animPendDelay[MAXBTN][ANIM_MAXF]; static int g_animPendN[MAXBTN]; static size_t g_animPendBytes[MAXBTN];
static volatile uint8_t g_animCmd[MAXBTN];     // Core 0 -> Core 1: 1 = instalar a animação recebida, 2 = remover a do botão
static volatile size_t g_animUsed = 0;          // bytes de quadros em uso (exibidos + a caminho): controla o orçamento
static volatile bool g_pendReady[MAXBTN], g_labelReady[MAXBTN];
static volatile uint8_t g_flashReq[MAXBTN];    // 1 = ação ok, 2 = erro (borda verde/vermelha no botão)
static char g_pendPage[48]; static volatile bool g_pageReady;   // nome da página atual (cabeçalho, canto direito)
static char g_toastPend[96]; static volatile uint8_t g_toastReady;   // 1 = ok (verde), 2 = erro (vermelho)
static char g_pendLabel[MAXBTN][64]; static volatile uint8_t g_pendFs[MAXBTN];   // texto já quebrado em linhas e tamanho da fonte, decididos pelo servidor
struct SlideEv { int i, v, ph; };                 // posição do dedo (0-1000) num botão-controle: ph 0 = encostou, 1 = arrastando, 2 = soltou
static QueueHandle_t pressQ, slideQ;
static lv_obj_t *g_sf[MAXBTN];                    // preenchimento (absoluto) ou marcador (relativo) de cada controle deslizante - só o Core 1 mexe
static int g_slv[MAXBTN], g_slLast[MAXBTN];       // nível mostrado (0-1000) e último valor enviado
static bool g_slDrag[MAXBTN]; static uint32_t g_slHold[MAXBTN], g_slSentAt[MAXBTN];   // arrastando; até quando ignorar o nível do servidor (ele ainda está aplicando o último valor)
static volatile int g_slPend[MAXBTN]; static volatile bool g_slReady[MAXBTN];         // nível vindo do servidor (Core 0 grava, Core 1 aplica)
static Preferences prefs;
static volatile bool g_saMode = false; static volatile uint8_t g_saUiReq = 0;   // modo autônomo ligado (Core 0 decide); pedido para o Core 1: 1 = mostrar, 2 = esconder
static lv_obj_t *g_wl[MAXBTN];   // texto dos botões Relógio/Clima do modo autônomo (só o Core 1 mexe)
static volatile uint32_t g_lastReply = 0;   // millis da última resposta de um servidor (qualquer código HTTP > 0): servidor presente, mesmo que com erro ou lento
#define REPLIED(c) do { if ((c) > 0) g_lastReply = millis(); } while (0)
static volatile bool g_usbMode = false;   // o servidor está sendo falado pelo cabo USB (usblink): sem Wi-Fi/mDNS/pareamento, o cabo é a prova de identidade
#define POLL_CAP (24 * 1024)
static uint8_t *g_pollBuf = nullptr;      // resposta de /api/deck pelo cabo (PSRAM)

// ---------------- Interface: grade cols x rows ----------------
#define GRID_Y 36   // faixa de status em cima (0-36); a grade tem 199 px de altura e termina 5 px antes do fim da tela (sem faixa de aviso: o resultado do toque aparece na borda do botão)

// Fontes Montserrat em qualquer tamanho (tiny_ttf), criadas na primeira vez que aparecem. Só o Core 1 (LVGL) chama.
static lv_font_t *fontFor(int px) {
  static lv_font_t *f[25];
  px = constrain(px, 8, 24);
  if (!f[px]) { f[px] = lv_tiny_ttf_create_data(montserrat_ttf, montserrat_ttf_len, px); if (f[px]) f[px]->fallback = &lv_font_montserrat_12; }
  return f[px] ? f[px] : (lv_font_t *)&lv_font_montserrat_12;
}
static bool g_demo = true;   // nomes de demonstração só até a primeira grade vinda do servidor
static lv_image_dsc_t g_dsc[MAXBTN];
static lv_obj_t *g_btn[MAXBTN], *g_imgObj[MAXBTN], *g_overlay[MAXBTN], *g_lbl[MAXBTN], *g_bar[MAXBTN], *g_statusDot, *g_statusLbl, *g_pageLbl;
static const char *DEMO_LABELS[8] = {"Mutar", "Câmera", "Música", "Terminal", "Luzes", "Gravar", "Chat", "Notas"};   // até o Mac mandar os reais

// Controle deslizante (Core 1): posiciona o preenchimento/marcador conforme o nível (absoluto) ou a posição do dedo (relativo: -1 = escondido)
static void slApply(int i) {
  if (!g_sf[i] || i >= g_ui.n) return; const Tile &tl = g_ui.t[i]; const int v = constrain(g_slv[i], -1, 1000);
  if (v < 0) { lv_obj_add_flag(g_sf[i], LV_OBJ_FLAG_HIDDEN); return; }
  lv_obj_remove_flag(g_sf[i], LV_OBJ_FLAG_HIDDEN);
  if (tl.slr) { const int th = 5; if (tl.sl == 1) { lv_obj_set_size(g_sf[i], th, tl.h); lv_obj_set_pos(g_sf[i], constrain(tl.w * v / 1000 - th / 2, 0, tl.w - th), 0); } else { lv_obj_set_size(g_sf[i], tl.w, th); lv_obj_set_pos(g_sf[i], 0, constrain(tl.h - tl.h * v / 1000 - th / 2, 0, tl.h - th)); } return; }
  if (tl.sl == 1) { lv_obj_set_size(g_sf[i], max(1, tl.w * v / 1000), tl.h); lv_obj_set_pos(g_sf[i], 0, 0); }
  else { const int h = max(1, tl.h * v / 1000); lv_obj_set_size(g_sf[i], tl.w, h); lv_obj_set_pos(g_sf[i], 0, tl.h - h); }
}
static void slPush(int i, int v, int ph) {   // entrega ao Core 0; se a fila encheu, descarta o mais antigo (o início e o fim do arrasto nunca se perdem)
  SlideEv e = {g_ui.t[i].i, v, ph};
  if (xQueueSend(slideQ, &e, 0) != pdTRUE) { SlideEv old; xQueueReceive(slideQ, &old, 0); xQueueSend(slideQ, &e, 0); }
}
static void slEvent(int i, lv_event_code_t c) {
  const Tile &tl = g_ui.t[i];
  if (c == LV_EVENT_PRESSED || c == LV_EVENT_PRESSING) {
    lv_indev_t *in = lv_indev_active(); if (!in) return; lv_point_t p; lv_indev_get_point(in, &p);
    const int pos = tl.sl == 1 ? (p.x - tl.x) * 1000 / max(1, tl.w) : (tl.y + tl.h - p.y) * 1000 / max(1, tl.h), v = constrain(pos, 0, 1000);
    const bool start = c == LV_EVENT_PRESSED;
    if (start) { g_slDrag[i] = true; g_slLast[i] = -100; }
    g_slv[i] = v; slApply(i);   // resposta imediata no próprio botão
    if (start || (abs(v - g_slLast[i]) >= 4 && millis() - g_slSentAt[i] >= 60)) { g_slLast[i] = v; g_slSentAt[i] = millis(); slPush(i, v, start ? 0 : 1); }
  } else if (c == LV_EVENT_RELEASED || c == LV_EVENT_PRESS_LOST) {
    if (!g_slDrag[i]) return; g_slDrag[i] = false; g_slHold[i] = millis() + 1500;   // o servidor ainda está aplicando: não deixa o nível antigo voltar na hora
    slPush(i, g_slLast[i] < 0 ? 0 : g_slv[i], 2);
    if (tl.slr) { g_slv[i] = -1; slApply(i); }
  }
}
// Códigos na fila de toques (pressQ): 0..999 = toque no botão; PRESS_LONG + índice = botão segurado; PRESS_SWIPE_NEXT/PREV = dedo deslizado na grade (troca de página)
#define PRESS_LONG 1000
#define PRESS_SWIPE_NEXT (-1)
#define PRESS_SWIPE_PREV (-2)
static volatile uint32_t g_swipeAt = 0;   // quando foi o último deslize: o toque que o LVGL ainda possa soltar depois dele é ignorado
static void evGesture(lv_event_t *) {   // Core 1: deslizar para a esquerda = próxima página, para a direita = anterior (só com o servidor presente; no modo autônomo é ignorado)
  lv_indev_t *in = lv_indev_active(); if (!in || g_saMode) return;
  const lv_dir_t d = lv_indev_get_gesture_dir(in); int code = d == LV_DIR_LEFT ? PRESS_SWIPE_NEXT : d == LV_DIR_RIGHT ? PRESS_SWIPE_PREV : 0;
  if (!code) return; g_swipeAt = millis(); Serial.printf("[gesto] %s\n", code == PRESS_SWIPE_NEXT ? "proxima pagina" : "pagina anterior"); xQueueSend(pressQ, &code, 0);
}
static void evBtn(lv_event_t *e) {
  int t = (int)(intptr_t)lv_event_get_user_data(e); lv_event_code_t c = lv_event_get_code(e);   // t = posição do botão na lista (não o índice da placa)
  if (g_ui.t[t].sl) { slEvent(t, c); return; }   // controle deslizante: não é toque de botão
  if (c == LV_EVENT_PRESSED) lv_obj_set_style_bg_opa(g_overlay[t], 120, 0);
  else if (c == LV_EVENT_RELEASED || c == LV_EVENT_PRESS_LOST) lv_obj_set_style_bg_opa(g_overlay[t], LV_OPA_TRANSP, 0);
  else if (c == LV_EVENT_LONG_PRESSED) { int idx = g_ui.t[t].i + PRESS_LONG; Serial.printf("[botao] %d segurado\n", g_ui.t[t].i); xQueueSend(pressQ, &idx, 0); }   // segurar: o servidor roda a ação alternativa do botão (ou a normal, se não houver); o LVGL não manda o CLICKED depois
  else if (c == LV_EVENT_CLICKED) { if (millis() - g_swipeAt < 400) return; int idx = g_ui.t[t].i; Serial.printf("[botao] %d (%s)\n", idx, lv_label_get_text(g_lbl[t])); xQueueSend(pressQ, &idx, 0); }   // o servidor identifica o botão pelo índice do canto superior esquerdo
}
static void flashEnd(lv_timer_t *t) { int i = (int)(intptr_t)lv_timer_get_user_data(t); if (g_btn[i]) lv_obj_set_style_outline_width(g_btn[i], 0, 0); }   // a grade pode ter mudado nesse meio tempo
static void flashBtn(int i, bool ok) {
  if (!g_btn[i]) return;
  lv_obj_set_style_outline_width(g_btn[i], 3, 0); lv_obj_set_style_outline_color(g_btn[i], lv_color_hex(ok ? 0x35D07F : 0xFF5C5C), 0); lv_obj_set_style_outline_opa(g_btn[i], LV_OPA_COVER, 0);
  lv_timer_t *t = lv_timer_create(flashEnd, 450, (void *)(intptr_t)i); lv_timer_set_repeat_count(t, 1);
}
static void buildButton(int i) {
  lv_obj_t *scr = lv_screen_active();
  const Geom &g = g_ui; const Tile &tl = g.t[i]; const int w = tl.w, h = tl.h;
  g_dsc[i] = {}; g_dsc[i].header.magic = LV_IMAGE_HEADER_MAGIC; g_dsc[i].header.cf = LV_COLOR_FORMAT_RGB565;
  g_dsc[i].header.w = w; g_dsc[i].header.h = h; g_dsc[i].header.stride = w * 2; g_dsc[i].data_size = w * h * 2; g_dsc[i].data = g_img[i];

  lv_obj_t *b = g_btn[i] = lv_obj_create(scr); lv_obj_set_size(b, w, h);
  lv_obj_set_pos(b, tl.x, tl.y);
  lv_obj_set_style_pad_all(b, 0, 0); lv_obj_set_style_border_width(b, 0, 0); lv_obj_set_style_shadow_width(b, 0, 0);
  lv_obj_set_style_radius(b, h < 50 ? 8 : 12, 0); lv_obj_set_style_clip_corner(b, true, 0); lv_obj_set_style_bg_color(b, lv_color_hex(0x1C1C20), 0);
  lv_obj_remove_flag(b, LV_OBJ_FLAG_SCROLLABLE); lv_obj_add_flag(b, LV_OBJ_FLAG_CLICKABLE);

  lv_obj_t *im = g_imgObj[i] = lv_image_create(b); lv_image_set_src(im, &g_dsc[i]); lv_obj_set_pos(im, 0, 0); lv_obj_remove_flag(im, LV_OBJ_FLAG_CLICKABLE);

  if (tl.wd) {   // Relógio/Clima do modo autônomo: texto atualizado pelo saUiTick()
    lv_obj_t *wl = g_wl[i] = lv_label_create(b); lv_obj_set_style_text_font(wl, fontFor(constrain(tl.h / 3, 12, 24)), 0); lv_obj_set_style_text_color(wl, lv_color_white(), 0);
    lv_obj_remove_flag(wl, LV_OBJ_FLAG_CLICKABLE); lv_label_set_text(wl, ""); lv_obj_center(wl);
  }
  if (tl.sl) {   // controle deslizante: preenchimento (absoluto) ou marcador do dedo (relativo), desenhado aqui para responder na hora ao dedo
    lv_obj_t *sf = g_sf[i] = lv_obj_create(b); lv_obj_set_style_pad_all(sf, 0, 0); lv_obj_set_style_border_width(sf, 0, 0); lv_obj_set_style_radius(sf, 0, 0); lv_obj_set_style_shadow_width(sf, 0, 0);
    lv_obj_set_style_bg_color(sf, lv_color_hex(tl.slc), 0); lv_obj_set_style_bg_opa(sf, tl.slr ? 230 : 120, 0); lv_obj_remove_flag(sf, LV_OBJ_FLAG_SCROLLABLE); lv_obj_remove_flag(sf, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_flag(b, LV_OBJ_FLAG_PRESS_LOCK);   // o arrasto continua mesmo se o dedo sair do botão
    lv_obj_remove_flag(b, LV_OBJ_FLAG_GESTURE_BUBBLE);   // arrastar o controle não troca de página
    g_slv[i] = tl.slr ? -1 : 0; slApply(i);
  }
  lv_obj_t *bar = g_bar[i] = lv_obj_create(b); lv_obj_set_size(bar, w, tl.bar); lv_obj_align(bar, LV_ALIGN_BOTTOM_MID, 0, 0);
  lv_obj_set_style_pad_all(bar, 0, 0); lv_obj_set_style_border_width(bar, 0, 0); lv_obj_set_style_radius(bar, 0, 0); lv_obj_set_style_shadow_width(bar, 0, 0);
  lv_obj_set_style_bg_color(bar, lv_color_black(), 0); lv_obj_set_style_bg_opa(bar, 140, 0); lv_obj_remove_flag(bar, LV_OBJ_FLAG_SCROLLABLE); lv_obj_remove_flag(bar, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_t *l = g_lbl[i] = lv_label_create(bar); lv_obj_set_style_text_font(l, fontFor(g.font), 0); lv_obj_set_style_text_color(l, lv_color_white(), 0);
  lv_obj_set_width(l, w); lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0); lv_label_set_long_mode(l, LV_LABEL_LONG_CLIP);   // quebra de linha vem pronta do servidor
  const char *t0 = g_demo && i < 8 ? DEMO_LABELS[i] : ""; lv_label_set_text(l, t0); lv_obj_center(l);
  if (!t0[0]) lv_obj_add_flag(bar, LV_OBJ_FLAG_HIDDEN);   // sem título: sem texto e sem faixa preta

  g_overlay[i] = lv_obj_create(b); lv_obj_set_size(g_overlay[i], w, h); lv_obj_set_pos(g_overlay[i], 0, 0);   // escurece ao pressionar
  lv_obj_set_style_pad_all(g_overlay[i], 0, 0); lv_obj_set_style_border_width(g_overlay[i], 0, 0); lv_obj_set_style_radius(g_overlay[i], 0, 0);
  lv_obj_set_style_bg_color(g_overlay[i], lv_color_black(), 0); lv_obj_set_style_bg_opa(g_overlay[i], LV_OPA_TRANSP, 0); lv_obj_remove_flag(g_overlay[i], LV_OBJ_FLAG_CLICKABLE);

  lv_obj_add_event_cb(b, evBtn, LV_EVENT_ALL, (void *)(intptr_t)i);
}
static void buildUi() {
  lv_obj_t *scr = lv_screen_active();
  lv_obj_set_style_bg_color(scr, lv_color_hex(0x0B0B0D), 0); lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0); lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
  for (int i = 0; i < g_ui.n; i++) buildButton(i);
  g_statusDot = lv_obj_create(scr); lv_obj_set_size(g_statusDot, 9, 9); lv_obj_set_pos(g_statusDot, 10, 14);   // faixa de status: amarelo procurando, verde Mac ok, vermelho sem Mac
  lv_obj_set_style_radius(g_statusDot, LV_RADIUS_CIRCLE, 0); lv_obj_set_style_border_width(g_statusDot, 0, 0); lv_obj_set_style_bg_opa(g_statusDot, LV_OPA_COVER, 0);
  lv_obj_remove_flag(g_statusDot, LV_OBJ_FLAG_CLICKABLE); lv_obj_remove_flag(g_statusDot, LV_OBJ_FLAG_SCROLLABLE); lv_obj_set_style_bg_color(g_statusDot, lv_color_hex(0xFFB300), 0);
  g_statusLbl = lv_label_create(scr); lv_obj_set_style_text_font(g_statusLbl, fontFor(12), 0); lv_obj_set_style_text_color(g_statusLbl, lv_color_hex(0x9A9AA6), 0);
  lv_label_set_text(g_statusLbl, "Procurando o Mac..."); lv_obj_set_pos(g_statusLbl, 26, 10);
  g_pageLbl = lv_label_create(scr); lv_obj_set_style_text_font(g_pageLbl, fontFor(12), 0); lv_obj_set_style_text_color(g_pageLbl, lv_color_hex(0xD8D8E0), 0);   // página atual (vem do servidor)
  lv_obj_set_width(g_pageLbl, 150); lv_obj_set_style_text_align(g_pageLbl, LV_TEXT_ALIGN_RIGHT, 0); lv_label_set_long_mode(g_pageLbl, LV_LABEL_LONG_CLIP); lv_label_set_text(g_pageLbl, ""); lv_obj_set_pos(g_pageLbl, SW - 10 - 150, 10);
}
static bool allocImages(const Geom &g);
static void animFree(int t) { if (g_anim[t].buf) { g_animUsed -= g_anim[t].bytes; heap_caps_free(g_anim[t].buf); } g_anim[t] = Anim(); }   // Core 1
// Core 1: o servidor mudou a lista de botões (grade/fonte/botões juntados): apaga os botões e refaz com a nova (as imagens e os nomes chegam em seguida)
static void rebuildGrid(const Geom &ng, bool imgChg, uint32_t gen) {
  for (int i = 0; i < MAXBTN; i++) { animFree(i); if (g_animCmd[i] == 1 && g_animPend[i]) { g_animUsed -= g_animPendBytes[i]; heap_caps_free(g_animPend[i]); g_animPend[i] = nullptr; } g_animCmd[i] = 0; }   // animações da lista antiga não valem mais
  for (int i = 0; i < g_ui.n; i++) { lv_image_cache_drop(&g_dsc[i]); if (g_btn[i]) { lv_obj_delete(g_btn[i]); g_btn[i] = nullptr; g_bar[i] = nullptr; g_sf[i] = nullptr; g_wl[i] = nullptr; } g_slDrag[i] = false; g_slv[i] = 0; }
  if (imgChg) allocImages(ng);   // botões/tamanhos novos: novos buffers (fundo escuro até chegarem as imagens)
  g_ui = ng; g_demo = false;
  for (lv_obj_t *o : {g_statusDot, g_statusLbl, g_pageLbl}) if (o) { if (ng.top >= GRID_Y) lv_obj_remove_flag(o, LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN); }   // sem a faixa de status: esconde o ponto, o texto de conexão e o nome da página
  for (int i = 0; i < g_ui.n; i++) buildButton(i);
  g_uiGen = gen;   // a rede já pode baixar imagens para esta lista
  Serial.printf("[grade] %d botoes (%dx%d), fonte %d:", ng.n, ng.cols, ng.rows, ng.font);
  for (int i = 0; i < ng.n; i++) Serial.printf(" #%d %dx%d", ng.t[i].i, ng.t[i].w, ng.t[i].h);
  Serial.println();
}
// Core 1: (re)aloca as imagens (exibida + recebida de cada botão, cada uma do tamanho do botão) na PSRAM
static bool allocImages(const Geom &g) {
  if (xSemaphoreTake(g_imgMux, pdMS_TO_TICKS(4000)) != pdTRUE) return false;
  for (int i = 0; i < MAXBTN; i++) { heap_caps_free(g_img[i]); heap_caps_free(g_pend[i]); g_img[i] = g_pend[i] = nullptr; g_pendReady[i] = false; g_imgBytes[i] = 0; }
  size_t total = 0; for (int i = 0; i < g.n; i++) total += tileBytes(g.t[i]) * 2;
  bool ok = total <= IMG_BUDGET;
  for (int i = 0; i < g.n && ok; i++) {
    const size_t bytes = tileBytes(g.t[i]);
    g_img[i] = (uint8_t *)heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM); g_pend[i] = (uint8_t *)heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM);
    if (!g_img[i] || !g_pend[i]) ok = false; else { uint16_t *p = (uint16_t *)g_img[i]; for (size_t k = 0; k < bytes / 2; k++) p[k] = IMG_DARK; g_imgBytes[i] = bytes; }
  }
  if (!ok) { for (int i = 0; i < MAXBTN; i++) { heap_caps_free(g_img[i]); heap_caps_free(g_pend[i]); g_img[i] = g_pend[i] = nullptr; g_imgBytes[i] = 0; } Serial.println("[grade] sem memoria para as imagens"); }
  xSemaphoreGive(g_imgMux); return ok;
}
// Core 1: aplica o que a rede deixou pronto
static void applyPending() {
  static int lastSt = -1;
  if (g_geomReady) { uint32_t gen = g_pendGen; Geom ng = g_pendGeom; bool ic = g_geomImgChg; g_geomImgChg = false; g_geomReady = false; rebuildGrid(ng, ic, gen); }   // gen lido ANTES da geometria: se mudar de novo no meio, a rede espera a próxima refeita
  const int n = g_ui.n;
  for (int i = 0; i < n; i++) {
    const size_t imgBytes = tileBytes(g_ui.t[i]);
    if (g_pendReady[i]) { if (g_img[i] && g_pend[i] && g_imgBytes[i] == imgBytes) memcpy(g_img[i], g_pend[i], imgBytes); g_pendReady[i] = false; lv_image_cache_drop(&g_dsc[i]); lv_obj_invalidate(g_imgObj[i]); }
    if (g_labelReady[i]) {
      lv_obj_set_style_text_font(g_lbl[i], fontFor(g_pendFs[i]), 0); lv_label_set_text(g_lbl[i], g_pendLabel[i]); lv_obj_center(g_lbl[i]);
      if (g_pendLabel[i][0]) lv_obj_remove_flag(g_bar[i], LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(g_bar[i], LV_OBJ_FLAG_HIDDEN);   // faixa preta só com título
      g_labelReady[i] = false;
    }
    if (g_slReady[i]) { if (g_ui.t[i].sl && !g_ui.t[i].slr && !g_slDrag[i] && (int32_t)(millis() - g_slHold[i]) >= 0) { g_slv[i] = g_slPend[i]; slApply(i); } if (!g_slDrag[i] && (int32_t)(millis() - g_slHold[i]) >= 0) g_slReady[i] = false; }
    if (g_flashReq[i]) { flashBtn(i, g_flashReq[i] == 1); g_flashReq[i] = 0; }
    if (g_animCmd[i]) {   // animação nova (ou removida) para o botão
      const uint8_t cmd = g_animCmd[i];
      animFree(i); g_dsc[i].data = g_img[i]; lv_image_cache_drop(&g_dsc[i]); lv_obj_invalidate(g_imgObj[i]);   // volta à imagem estática
      if (cmd == 1 && g_animPend[i] && g_animPendN[i] >= 2) {
        Anim &a = g_anim[i]; a.n = g_animPendN[i]; a.buf = g_animPend[i]; a.bytes = g_animPendBytes[i]; a.cur = 0; a.nextAt = millis();
        memcpy(a.delay, g_animPendDelay[i], sizeof a.delay); g_animPend[i] = nullptr;
      } else if (g_animPend[i]) { g_animUsed -= g_animPendBytes[i]; heap_caps_free(g_animPend[i]); g_animPend[i] = nullptr; }
      g_animCmd[i] = 0;
    }
  }
  if (g_pageReady) { lv_label_set_text(g_pageLbl, g_pendPage); g_pageReady = false; }
  g_toastReady = 0;   // sem faixa de aviso: o resultado do toque aparece na borda verde/vermelha do botão
  int st = g_status + (g_usbMode ? 10 : 0) + (g_saMode ? 20 : 0);
  if (st != lastSt) {
    lastSt = st; st = g_status; lv_obj_set_style_bg_color(g_statusDot, lv_color_hex(g_saMode ? 0x4FC3F7 : st == ST_OK ? 0x35D07F : st == ST_OFF ? 0xFF5C5C : st == ST_UNPAIRED ? 0xB388FF : 0xFFB300), 0);
    lv_label_set_text(g_statusLbl, g_saMode ? g_saUi.tAuto : st == ST_OK ? (g_usbMode ? "Mac conectado (USB)" : "Mac conectado") : st == ST_OFF ? "Mac nao encontrado" : st == ST_UNPAIRED ? "Nao pareado: clique em Parear no Mac" : "Procurando o Mac...");
  }
}

// Core 1: avança o quadro de cada botão animado quando chega a hora (só redesenha a área do botão)
static void animTick() {
  const uint32_t now = millis();
  for (int i = 0; i < g_ui.n; i++) {
    Anim &a = g_anim[i]; if (a.n < 2 || !a.buf || !g_imgObj[i] || (int32_t)(now - a.nextAt) < 0) continue;
    a.cur = (a.cur + 1) % a.n; const size_t fb = tileBytes(g_ui.t[i]);
    g_dsc[i].data = a.buf + (size_t)a.cur * fb; lv_image_cache_drop(&g_dsc[i]); lv_obj_invalidate(g_imgObj[i]);
    a.nextAt = now + max<uint32_t>(a.delay[a.cur], 20);   // a partir de agora (não acumula atraso se a tela atrasar)
  }
}

// ---------------- Rede (Core 0) ----------------
static String g_host, g_tok; static uint16_t g_port = 0;   // g_tok: chave de acesso ao Mac (recebida no pareamento, guardada na NVS)
static int g_imgRev[MAXBTN], g_fsCur[MAXBTN], g_animRev[MAXBTN]; static char g_labelCur[MAXBTN][64], g_pageCur[48];
static int g_fail = 0;

static String url(const char *path) { return "http://" + g_host + ":" + String(g_port) + path; }
static void netFail() { if (++g_fail >= 3) { g_status = ST_OFF; g_host = ""; g_port = 0; } }   // 3 falhas seguidas: procura o Mac de novo

static bool discover() {
  g_status = g_status == ST_OK ? ST_OFF : g_status;
  String fixed = prefs.getString("host", "");   // endereço fixo opcional (serial: H a.b.c.d), se o mDNS da rede não funcionar
  if (fixed.length()) { g_host = fixed; g_port = 8765; return true; }
  int n = MDNS.queryService("streamdeck", "tcp");
  if (n > 0) { g_host = MDNS.address(0).toString(); g_port = MDNS.port(0); Serial.printf("[rede] Mac achado por mDNS: %s:%u\n", g_host.c_str(), g_port); return true; }
  return false;
}
static void goUnpaired() {   // 401: o Mac não reconhece a chave (placa nova, ou acesso revogado)
  if (g_status != ST_UNPAIRED) Serial.println("[pareamento] o Mac recusou a chave: aguardando pareamento");
  g_status = ST_UNPAIRED; g_pendPage[0] = 0; g_pageCur[0] = 0; g_pageReady = true;
}
static bool fetchImg(int t) {
  while (g_pendReady[t]) delay(10);   // espera o Core 1 consumir a anterior
  for (int w = 0; g_uiGen != g_netGen && w < 300; w++) delay(10);   // lista nova: espera o Core 1 refazer os buffers (até 3 s)
  if (g_uiGen != g_netGen) return false;
  if (xSemaphoreTake(g_imgMux, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
  const size_t bytes = tileBytes(g_net.t[t]); bool ok = false;
  if (g_pend[t] && g_imgBytes[t] == bytes && g_usbMode) {   // pelo cabo
    char path[40]; snprintf(path, sizeof path, "/api/img/%d.raw", g_net.t[t].i); size_t n = 0;
    int code = usbRequest(1, path, nullptr, 0, g_pend[t], bytes, &n, 3000); ok = code == 200 && n == bytes;
  } else if (g_pend[t] && g_imgBytes[t] == bytes) {
    HTTPClient http; http.setConnectTimeout(1500); http.setTimeout(3000); http.setUserAgent("StreamDeckESP/1");
    http.begin(url(("/api/img/" + String(g_net.t[t].i) + ".raw").c_str())); http.addHeader("X-Deck", g_tok);   // addHeader DEPOIS do begin: begin() limpa os cabeçalhos
    int code = http.GET(); REPLIED(code);
    if (code == 401) { http.end(); xSemaphoreGive(g_imgMux); goUnpaired(); return false; }
    if (code == 200 && http.getSize() == bytes) ok = http.getStream().readBytes((char *)g_pend[t], bytes) == bytes;
    http.end();
  }
  xSemaphoreGive(g_imgMux);
  return ok;   // o poll() libera todas as imagens/rótulos juntos para o Core 1 (troca de página sem "piscar" botão a botão)
}
// Baixa os quadros da animação do botão t (best-effort: se não couber no orçamento ou falhar, o botão fica estático)
static bool fetchAnim(int t, int n) {
  if (n < 2 || n > ANIM_MAXF) return false;
  for (int w = 0; g_uiGen != g_netGen && w < 300; w++) delay(10);   // lista nova: espera o Core 1 refazer a tela
  if (g_uiGen != g_netGen) return false;
  for (int w = 0; g_animCmd[t] && w < 200; w++) delay(10);          // o Core 1 ainda não pegou a anterior
  if (g_animCmd[t]) return false;
  const size_t fb = tileBytes(g_net.t[t]), total = (size_t)n * fb;
  if (g_animUsed + total > ANIM_BUDGET) { Serial.printf("[anim] botao %d: sem orcamento (%u KB em uso)\n", g_net.t[t].i, (unsigned)(g_animUsed / 1024)); return false; }
  uint8_t *buf = (uint8_t *)heap_caps_malloc(total, MALLOC_CAP_SPIRAM); if (!buf) return false;
  g_animUsed += total;
  if (g_usbMode) {   // pelo cabo: cabeçalho (4 + 2n bytes) à parte, quadros direto no buffer
    char path[40]; snprintf(path, sizeof path, "/api/anim/%d.bin", g_net.t[t].i); uint8_t head[4 + 2 * ANIM_MAXF]; size_t got = 0;
    int c = usbRequest(1, path, head, 4 + 2 * n, buf, total, &got, 8000); bool good = c == 200 && got == 4 + 2 * n + total && (head[0] | (head[1] << 8)) == n;
    if (!good) { g_animUsed -= total; heap_caps_free(buf); return false; }
    for (int k = 0; k < n; k++) g_animPendDelay[t][k] = head[4 + 2 * k] | (head[5 + 2 * k] << 8);
    g_animPend[t] = buf; g_animPendN[t] = n; g_animPendBytes[t] = total; g_animCmd[t] = 1;
    Serial.printf("[anim] botao %d: %d quadros, %u KB (USB)\n", g_net.t[t].i, n, (unsigned)(total / 1024)); return true;
  }
  HTTPClient http; http.setConnectTimeout(1500); http.setTimeout(8000); http.setUserAgent("StreamDeckESP/1");
  http.begin(url(("/api/anim/" + String(g_net.t[t].i) + ".bin").c_str())); http.addHeader("X-Deck", g_tok);
  int code = http.GET(); bool ok = false;
  if (code == 200 && http.getSize() == (int)(4 + 2 * n + total)) {
    WiFiClient *st = http.getStreamPtr(); uint8_t head[4];
    if (st->readBytes((char *)head, 4) == 4 && (head[0] | (head[1] << 8)) == n) {
      uint8_t dl[2 * ANIM_MAXF];
      if (st->readBytes((char *)dl, 2 * n) == (size_t)(2 * n) && st->readBytes((char *)buf, total) == total) { for (int k = 0; k < n; k++) g_animPendDelay[t][k] = dl[2 * k] | (dl[2 * k + 1] << 8); ok = true; }
    }
  }
  http.end();
  if (!ok) { g_animUsed -= total; heap_caps_free(buf); return false; }
  g_animPend[t] = buf; g_animPendN[t] = n; g_animPendBytes[t] = total; g_animCmd[t] = 1;   // entrega ao Core 1
  Serial.printf("[anim] botao %d: %d quadros, %u KB\n", g_net.t[t].i, n, (unsigned)(total / 1024));
  return true;
}
// ---------------- Modo autônomo: perfil guardado na flash (Core 0) ----------------
// GET de um caminho do servidor (por Wi-Fi ou pelo cabo) para um buffer: devolve o status HTTP (ou <= 0) e o tamanho do corpo
static int netGet(const char *path, uint8_t *dst, size_t cap, size_t *len) {
  *len = 0;
  if (g_usbMode) return usbRequest(1, path, nullptr, 0, dst, cap, len, 4000);
  HTTPClient http; http.setConnectTimeout(1500); http.setTimeout(4000); http.setUserAgent("StreamDeckESP/1"); http.begin(url(path)); http.addHeader("X-Deck", g_tok);
  int code = http.GET(); REPLIED(code); if (code != 200) { http.end(); return code; }
  int sz = http.getSize(); if (sz <= 0 || (size_t)sz > cap) { http.end(); return -2; }
  size_t got = http.getStream().readBytes((char *)dst, sz); http.end(); *len = got; return got == (size_t)sz ? 200 : -3;
}
static uint32_t g_saFailAt = 0;
// O servidor anunciou outra revisão do perfil autônomo: baixa o perfil e as imagens e só então troca (commit). "0" = o modo autônomo foi desligado: apaga.
static void saSync(const char *want) {
  if (!strcmp(want, "0")) { if (saHave()) saClear(); return; }
  if (!strcmp(want, saRev())) return;
  if (g_saFailAt && millis() - g_saFailAt < 30000) return;
  const size_t CAP = 64 * 1024; uint8_t *buf = (uint8_t *)heap_caps_malloc(CAP, MALLOC_CAP_SPIRAM), *prof = nullptr;
  if (!buf) return;
  bool ok = false; size_t n = 0; JsonDocument d;
  if (netGet("/api/sa", buf, CAP, &n) == 200 && n > 0 && !deserializeJson(d, (const char *)buf, n)) {
    prof = (uint8_t *)heap_caps_malloc(n, MALLOC_CAP_SPIRAM); ok = prof != nullptr; if (ok) memcpy(prof, buf, n);
    for (JsonObject t : d["tiles"].as<JsonArray>()) {
      if (!ok) break; if (t["wd"].is<const char *>()) continue;   // relógio/clima: a placa desenha
      char path[40], file[32]; snprintf(path, sizeof path, "/api/sa/img/%d.raw", (int)(t["i"] | 0)); snprintf(file, sizeof file, "/sa/img/%d.raw", (int)(t["i"] | 0));
      size_t m = 0; ok = netGet(path, buf, CAP, &m) == 200 && m > 0 && saWriteFile(file, buf, m);
    }
    static const char *KINDS[8] = {"sun", "moon", "partly", "cloud", "fog", "rain", "storm", "snow"};
    for (int k = 0; k < 8 && ok; k++) { char path[40], file[32]; snprintf(path, sizeof path, "/api/sa/icon/%s.raw", KINDS[k]); snprintf(file, sizeof file, "/sa/icon/%s.raw", KINDS[k]); size_t m = 0; ok = netGet(path, buf, CAP, &m) == 200 && m > 0 && saWriteFile(file, buf, m); }
    if (ok) ok = saCommitProfile(prof, n) && saLoadProfile();
  }
  heap_caps_free(buf); heap_caps_free(prof);
  if (ok) { g_saFailAt = 0; Serial.printf("[sa] perfil %s recebido do servidor\n", saRev()); } else { g_saFailAt = millis(); Serial.println("[sa] falha ao baixar o perfil (tenta de novo em 30 s)"); }
}
static uint32_t batMv() {   // GPIO9 = divisor da bateria (ver docs/hardware/ES3C28P.md): média de 16 leituras em mV; o servidor aplica K e a curva
  uint32_t sum = 0; for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(9);
  return sum / 16;
}
static void poll() {
  const bool wokeSent = g_wokePend;
  const String deckPath = "/api/deck?w=" + String(BOARD.w) + "&h=" + String(BOARD.h) + "&ppi=" + String(BOARD.ppi) + "&fill=" + String(BOARD.fill) + "&sa=" + String(saRev()) + "&cap=tiles,anim,slide&bmv=" + String(batMv()) + (g_wokePend ? "&woke=1" : "");   // informa a tela: o servidor calcula a grade
  JsonDocument doc;
  if (g_usbMode) {   // pelo cabo
    size_t n = 0; int code = g_pollBuf ? usbRequest(1, deckPath.c_str(), nullptr, 0, g_pollBuf, POLL_CAP, &n, 3000) : -1;
    if (code != 200 || n == 0 || n > POLL_CAP) { netFail(); return; }
    if (deserializeJson(doc, (const char *)g_pollBuf, n) || !doc["buttons"].is<JsonArray>()) { netFail(); return; }
  } else {
    HTTPClient http; http.setConnectTimeout(1500); http.setTimeout(3000); http.setUserAgent("StreamDeckESP/1"); http.begin(url(deckPath.c_str())); http.addHeader("X-Deck", g_tok);
    int code = http.GET(); REPLIED(code);
    if (code == 401) { http.end(); goUnpaired(); return; }
    if (code != 200) { http.end(); netFail(); return; }
    String body = http.getString(); http.end();
    if (deserializeJson(doc, body) || !doc["buttons"].is<JsonArray>()) { netFail(); return; }
  }
  g_blTarget = constrain((int)(doc["bl"] | 255), 10, 255);   // brilho e "apagar" vêm do servidor (servidor antigo: 255, ligada)
  if (wokeSent) g_wokePend = false; else if (!g_wokePend) g_scrOff = doc["off"] | false;   // acordou por toque: o servidor já foi avisado nesta chamada; a resposta antiga de "apagar" é ignorada
  if (doc["pwr"] | false) g_powerOff = true;   // desligar: o servidor manda uma única vez
  g_fail = 0; if (g_status != ST_OK) { g_status = ST_OK; Serial.printf("[rede] servidor ok (%s)\n", g_host.c_str()); }
  Geom ng; memset(&ng, 0, sizeof ng);
  const int cols = doc["cols"] | 4, rows = doc["rows"] | 2, font = doc["font"] | 12, top = doc["top"] | 36;
  JsonArray bs = doc["buttons"].as<JsonArray>();
  if (doc["tiles"] | false) {   // servidor com botões juntados: lista de botões com retângulo próprio
    ng.cols = cols; ng.rows = rows; ng.font = font; ng.top = top; ng.n = min((int)bs.size(), MAXBTN);
    for (int k = 0; k < ng.n; k++) {
      uint8_t sl = 0, slr = 0; uint32_t slc = 0;
      if (bs[k]["sl"].is<JsonObject>()) { const char *o = bs[k]["sl"]["o"] | "h"; sl = o[0] == 'v' ? 2 : 1; slr = (bs[k]["sl"]["r"] | 0) ? 1 : 0; slc = bs[k]["sl"]["c"] | 0x19D9C8; }
      ng.t[k] = {bs[k]["i"] | 0, bs[k]["x"] | 0, bs[k]["y"] | 0, bs[k]["w"] | 0, bs[k]["h"] | 0, bs[k]["bar"] | 0, sl, slr, slc};
    }
  } else makeUniform(ng, cols, rows, doc["w"] | 73, doc["h"] | 96, doc["bar"] | 32, font, top);   // servidor antigo: grade uniforme
  bool bad = cols < 2 || cols > MAXCOLS || rows < 2 || rows > MAXROWS || ng.n < 1 || top < 0 || top > 60;
  size_t total = 0;
  for (int k = 0; k < ng.n && !bad; k++) { const Tile &t = ng.t[k]; total += tileBytes(t) * 2;
    if (t.i < 0 || t.i >= MAXBTN || t.w < 20 || t.h < 20 || t.x < 0 || t.y < 0 || t.x + t.w > BOARD.w || t.y + t.h > BOARD.h || t.bar < 8 || t.bar > t.h) bad = true; }
  if (bad || total > IMG_BUDGET) { netFail(); return; }   // lista que não cabe (tela, memória): ignora
  if (!sameGeom(ng, g_net)) {   // grade, botões, faixa ou fonte mudaram: a tela é refeita
    bool ic = !sameImgGeom(ng, g_net);   // quais botões/tamanhos mudaram: as imagens (e as versões) de antes não valem mais
    if (g_geomReady) ic = ic || g_geomImgChg;
    g_net = ng;
    for (int i = 0; i < MAXBTN; i++) { if (ic) g_imgRev[i] = 0; g_animRev[i] = 0; g_fsCur[i] = 0; g_labelCur[i][0] = 0; }
    g_pendGeom = ng; g_geomImgChg = ic; g_pendGen = ++g_netGen; g_geomReady = true;   // o Core 1 refaz a tela antes de aplicar o que vem a seguir (ele trata a lista primeiro)
    Serial.printf("[rede] lista nova: %d botoes, %dx%d fonte %d\n", ng.n, ng.cols, ng.rows, ng.font);
  }
  const int nb = g_net.n;
  for (int i = 0; i < nb && i < (int)bs.size(); i++) if (g_net.t[i].sl && !g_net.t[i].slr) { g_slPend[i] = constrain((int)(bs[i]["sl"]["v"] | 0), 0, 1000); g_slReady[i] = true; }   // nível do servidor (volume atual): o Core 1 aplica, menos durante o arrasto
  bool imgChg[MAXBTN] = {}, lblChg[MAXBTN] = {}; int newRev[MAXBTN] = {};
  for (int i = 0; i < nb && i < (int)bs.size(); i++) {
    const char *lb = bs[i]["label"] | ""; int rev = bs[i]["img"] | 0, fs = bs[i]["fs"] | 12; newRev[i] = rev;
    if (fs != g_fsCur[i] || strncmp(lb, g_labelCur[i], sizeof g_labelCur[i]) != 0) { strlcpy(g_pendLabel[i], lb, sizeof g_pendLabel[i]); g_pendFs[i] = fs; lblChg[i] = true; }
    if (rev != g_imgRev[i]) { if (!fetchImg(i)) { if (g_status != ST_UNPAIRED) netFail(); return; } imgChg[i] = true; }   // falhou: nada é aplicado e tenta de novo na próxima consulta
  }
  for (int i = 0; i < nb && i < (int)bs.size(); i++) {   // animações (GIF): best-effort, depois das imagens estáticas
    const int an = bs[i]["anim"]["n"] | 0, ar = bs[i]["anim"]["rev"] | 0;
    if (an >= 2) { if (ar != g_animRev[i]) { g_animRev[i] = ar; if (!fetchAnim(i, an)) g_animRev[i] = 0; } }   // falhou: tenta de novo na próxima consulta
    else if (g_animRev[i]) { g_animRev[i] = 0; g_animCmd[i] = 2; }   // o botão deixou de ter animação
  }
  const char *pgName = doc["page"] | "";  bool pgChg = strncmp(pgName, g_pageCur, sizeof g_pageCur) != 0;
  if (pgChg) { strlcpy(g_pageCur, pgName, sizeof g_pageCur); strlcpy(g_pendPage, pgName, sizeof g_pendPage); g_pageReady = true; }
  int nimg = 0;
  for (int i = 0; i < nb; i++) {   // tudo baixado: libera junto
    if (lblChg[i]) { strlcpy(g_labelCur[i], g_pendLabel[i], sizeof g_labelCur[i]); g_fsCur[i] = g_pendFs[i]; g_labelReady[i] = true; }
    if (imgChg[i]) { g_imgRev[i] = newRev[i]; g_pendReady[i] = true; nimg++; }
  }
  if (nimg) Serial.printf("[rede] %d imagem(ns) atualizada(s), pagina \"%s\"\n", nimg, g_pageCur);
  { const uint32_t srvT = doc["t"] | 0; if (srvT) saTimeFromServer(srvT); const char *want = doc["sa"] | ""; if (want[0]) saSync(want); }   // hora do servidor (sem internet) e perfil autônomo
}
static void sendSlide(const SlideEv &e) {   // posição do dedo no controle: sem aviso nem borda (a resposta só confirma)
  char path[64]; snprintf(path, sizeof path, "/api/slide/%d?v=%d&p=%d", e.i, e.v, e.ph);
  if (g_usbMode) { static uint8_t rb[256]; size_t rn = 0; usbRequest(2, path, nullptr, 0, rb, sizeof rb, &rn, 2000); return; }
  HTTPClient http; http.setConnectTimeout(1000); http.setTimeout(2000); http.setUserAgent("StreamDeckESP/1"); http.begin(url(path)); http.addHeader("X-Deck", g_tok);
  int code = http.POST((uint8_t *)"", 0); http.end();
  if (code == 401) goUnpaired(); else if (code <= 0) netFail();
}
static void sendPress(int pc) {   // pc = código da pressQ (ver PRESS_LONG)
  int code; String resp; char path[40]; int i = pc;
  if (pc == PRESS_SWIPE_NEXT || pc == PRESS_SWIPE_PREV) snprintf(path, sizeof path, "/api/swipe/%s", pc == PRESS_SWIPE_NEXT ? "next" : "prev");
  else if (pc >= PRESS_LONG) { i = pc - PRESS_LONG; snprintf(path, sizeof path, "/api/press/%d?long=1", i); }
  else snprintf(path, sizeof path, "/api/press/%d", i);
  if (g_usbMode) {   // pelo cabo
    static uint8_t rb[1024]; size_t rn = 0;
    code = usbRequest(2, path, nullptr, 0, rb, sizeof rb - 1, &rn, 6000);
    if (code > 0 && rn < sizeof rb) { rb[rn] = 0; resp = String((const char *)rb); }
  } else {
    HTTPClient http; http.setConnectTimeout(1500); http.setTimeout(6000); http.setUserAgent("StreamDeckESP/1"); http.begin(url(path));
    http.addHeader("X-Deck", g_tok);
    code = http.POST((uint8_t *)"", 0); resp = code > 0 ? http.getString() : String(); http.end();
  }
  REPLIED(code);
  JsonDocument rd; const char *tt = ""; bool quiet = false;
  if (resp.length() && !deserializeJson(rd, resp)) { tt = rd["toast"] | ""; quiet = rd["quiet"] | false; }   // quiet: navegação (a tela inteira muda): sem aviso nem borda
  int ti = -1; for (int k = 0; k < g_net.n; k++) if (g_net.t[k].i == i) ti = k;   // posição do botão na lista
  char nm[64]; strlcpy(nm, ti >= 0 ? g_labelCur[ti] : "", sizeof nm); for (char *c = nm; *c; c++) if (*c == '\n') *c = ' ';   // nome em uma linha só
  if (code == 401) { goUnpaired(); strlcpy(g_toastPend, "Placa nao pareada: clique em Parear no Mac", sizeof g_toastPend); g_toastReady = 2; }
  else if (code == 200 && quiet) { g_fail = 0; }
  else if (code == 200) { g_fail = 0; if (ti >= 0) g_flashReq[ti] = 1; if (tt[0]) strlcpy(g_toastPend, tt, sizeof g_toastPend); else snprintf(g_toastPend, sizeof g_toastPend, "%s: ok", nm); g_toastReady = 1; }
  else { if (ti >= 0) g_flashReq[ti] = 2; if (tt[0]) strlcpy(g_toastPend, tt, sizeof g_toastPend); else snprintf(g_toastPend, sizeof g_toastPend, code <= 0 ? "%s: Mac nao respondeu" : "%s: falhou", nm); g_toastReady = 2; if (code <= 0) netFail(); }
  Serial.printf("[rede] toque %d -> http %d\n", i, code);
}
// Pareamento: o Mac só entrega a chave enquanto a janela "Parear placa" (90 s) estiver aberta na página de configuração.
static void tryPair() {
  HTTPClient http; http.setConnectTimeout(1500); http.setTimeout(3000); http.setUserAgent("StreamDeckESP/1"); http.begin(url("/api/pair"));
  int code = http.POST((uint8_t *)"", 0);
  if (code == 200) {
    JsonDocument d; const char *t = ""; String b = http.getString();
    if (!deserializeJson(d, b)) t = d["token"] | "";
    if (strlen(t) >= 20) { g_tok = t; prefs.putString("tok", g_tok); g_fail = 0; g_status = ST_SEARCH; Serial.println("[pareamento] chave recebida e guardada"); }   // a chave nunca vai para o log
  } else if (code <= 0) netFail();
  http.end();
}
static bool g_everUp = false;   // já conectou ao Wi-Fi desde o boot (o portal só abre sozinho se nunca conectou)
static void nap(uint32_t ms) {   // espera; com o portal aberto continua atendendo a página (a cada 10 ms) em vez de dormir
  if (!portalActive()) { delay(ms); return; }
  for (uint32_t t = millis(); millis() - t < ms; delay(10)) portalTick(WiFi.status() == WL_CONNECTED, g_everUp);
}
// ---------------- Modo autônomo: entrar, sair, tocar (Core 0) ----------------
static uint32_t g_offSince = 0;
// Monta a grade a partir do perfil guardado (mesmo caminho que o poll() usa com a lista do servidor): o Core 1 refaz a tela e as imagens vêm da flash
static void saApplyGrid() {
  if (!saHave()) return;
  JsonObjectConst p = saProfile(); JsonArrayConst tl = p["tiles"]; Geom ng; memset(&ng, 0, sizeof ng);
  ng.cols = p["geom"]["cols"] | 4; ng.rows = p["geom"]["rows"] | 2; ng.font = p["geom"]["font"] | 12; ng.top = p["geom"]["top"] | 36; ng.n = min((int)tl.size(), MAXBTN);
  for (int k = 0; k < ng.n; k++) {
    const char *wd = tl[k]["wd"] | ""; uint8_t w = !strcmp(wd, "clock") ? 1 : !strcmp(wd, "weather") ? 2 : 0;
    ng.t[k] = {tl[k]["i"] | 0, tl[k]["x"] | 0, tl[k]["y"] | 0, tl[k]["w"] | 0, tl[k]["h"] | 0, tl[k]["bar"] | 0, 0, 0, 0, w};
  }
  bool bad = ng.n < 1; size_t total = 0;
  for (int k = 0; k < ng.n && !bad; k++) { const Tile &t = ng.t[k]; total += tileBytes(t) * 2; if (t.i < 0 || t.i >= MAXBTN || t.w < 20 || t.h < 20 || t.x < 0 || t.y < 0 || t.x + t.w > BOARD.w || t.y + t.h > BOARD.h || t.bar < 8 || t.bar > t.h) bad = true; }
  if (bad || total > IMG_BUDGET) { Serial.println("[sa] perfil nao cabe na tela"); return; }
  if (!sameGeom(ng, g_net)) {
    bool ic = !sameImgGeom(ng, g_net); if (g_geomReady) ic = ic || g_geomImgChg;
    g_net = ng; for (int i = 0; i < MAXBTN; i++) { if (ic) g_imgRev[i] = 0; g_animRev[i] = 0; g_fsCur[i] = 0; g_labelCur[i][0] = 0; }
    g_pendGeom = ng; g_geomImgChg = ic; g_pendGen = ++g_netGen; g_geomReady = true;
  }
  for (int i = 0; i < MAXBTN; i++) if (g_animRev[i]) { g_animRev[i] = 0; g_animCmd[i] = 2; }
  for (int k = 0; k < g_net.n; k++) {   // nomes e imagens (do mesmo jeito que o poll(): tudo pronto, depois libera junto)
    const char *lb = tl[k]["label"] | ""; strlcpy(g_pendLabel[k], lb, sizeof g_pendLabel[k]); g_pendFs[k] = tl[k]["fs"] | 12; strlcpy(g_labelCur[k], lb, sizeof g_labelCur[k]); g_fsCur[k] = g_pendFs[k]; g_labelReady[k] = true;
  }
  for (int w = 0; g_uiGen != g_netGen && w < 300; w++) delay(10);   // espera o Core 1 refazer os buffers
  if (g_uiGen == g_netGen && xSemaphoreTake(g_imgMux, pdMS_TO_TICKS(2000)) == pdTRUE) {
    for (int k = 0; k < g_net.n; k++) {
      if (g_net.t[k].wd || !g_pend[k]) continue; char file[32]; snprintf(file, sizeof file, "/sa/img/%d.raw", g_net.t[k].i); size_t got = 0, bytes = tileBytes(g_net.t[k]);
      if (g_imgBytes[k] == bytes && saReadFile(file, g_pend[k], bytes, &got) && got == bytes) { g_pendReady[k] = true; g_imgRev[k] = tl[k]["img"] | 0; }
    }
    xSemaphoreGive(g_imgMux);
  }
  const char *pn = p["page"] | ""; strlcpy(g_pageCur, pn, sizeof g_pageCur); strlcpy(g_pendPage, pn, sizeof g_pendPage); g_pageReady = true;
}
static void saEnter() {
  if (!saHave() || g_saMode) return;
  saApplyGrid(); g_saMode = true; g_saUiReq = 1; Serial.println("[sa] servidor ausente: modo autonomo");
}
static void saLeave() {
  if (!g_saMode) return;
  g_saMode = false; g_saUiReq = 2; g_status = ST_SEARCH; g_fail = 0;
  for (int i = 0; i < MAXBTN; i++) { g_imgRev[i] = 0; g_fsCur[i] = 0; g_labelCur[i][0] = 0; g_animRev[i] = 0; }   // a grade do servidor volta a ser baixada inteira
  g_pageCur[0] = 0; Serial.println("[sa] servidor de volta: modo normal");
}
static void saPress(int idx) {   // toque num botão no modo autônomo: executa o `ex` do perfil (webhook / Home Assistant / MQTT) ou avisa que precisa do computador
  int ti = -1; for (int k = 0; k < g_net.n; k++) if (g_net.t[k].i == idx) ti = k;
  if (ti < 0 || !saHave()) { Serial.printf("[sa] toque %d ignorado (tile %d, perfil %d)\n", idx, ti, (int)saHave()); return; }
  JsonObjectConst tile = saProfile()["tiles"][ti];
  Serial.printf("[sa] toque %d -> botao %d: %s\n", idx, ti, !tile["ex"].isNull() ? (const char *)(tile["ex"]["k"] | "?") : tile["wd"].is<const char *>() ? "widget" : "precisa do computador");
  if (tile["wd"].is<const char *>()) return;                       // relógio/clima: nada a executar
  if (!tile["ex"].isNull() && execStart(tile["ex"], ti)) return;   // (variante const: is<JsonObject>() seria sempre falso)   // o resultado chega por execDone (borda verde/vermelha)
  g_flashReq[ti] = 2;
}
static void execDone(int tile, bool ok) { if (tile >= 0 && tile < MAXBTN) g_flashReq[tile] = ok ? 1 : 2; }
static bool probeServer() {   // o servidor reapareceu? (responde ao /api/deck, mesmo que peça pareamento)
  HTTPClient http; http.setConnectTimeout(1500); http.setTimeout(2500); http.setUserAgent("StreamDeckESP/1");
  http.begin(url(("/api/deck?w=" + String(BOARD.w) + "&h=" + String(BOARD.h)).c_str())); http.addHeader("X-Deck", g_tok);
  int code = http.GET(); http.end(); REPLIED(code); return code == 200 || code == 401;
}

static void netTask(void *) {
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin();   // reaproveita as credenciais já gravadas (nunca lidas/registradas aqui)
  MDNS.begin("streamdeck-esp");
  uint32_t lastPoll = 0, lastLog = 0, lastProbe = 0; bool wasUp = false, ntpOn = false;
  for (;;) {
    // modo autônomo: só entra quando NÃO há servidor mesmo: sem cabo USB e sem nenhuma resposta HTTP há 8 s (resposta com erro ou lenta conta como servidor presente), por mais 4 s,
    // e com perfil guardado. Sai quando o cabo volta ou o servidor responde.
    { const bool alive = usbActive() || (g_lastReply && millis() - g_lastReply < 8000 && WiFi.status() == WL_CONNECTED);
      if (alive) { g_offSince = 0; if (g_saMode) saLeave(); }
      else { if (!g_offSince) g_offSince = millis(); if (!g_saMode && saHave() && millis() > 20000 && millis() - g_offSince > 4000) saEnter(); } }   // (nos primeiros 20 s de boot o Wi-Fi e a busca do servidor ainda estão acontecendo)
    if (usbActive()) {
      if (g_saMode) saLeave();   // servidor presente pelo cabo: ele manda; sem Wi-Fi, mDNS nem pareamento. Consulta mais rápida (o cabo é barato)
      if (!g_usbMode) { g_usbMode = true; g_fail = 0; g_status = ST_SEARCH; g_host = "usb"; lastPoll = 0; Serial.println("[usb] servidor conectado pelo cabo"); }
      { SlideEv se; while (xQueueReceive(slideQ, &se, 0) == pdTRUE) sendSlide(se); }
      int b; while (xQueueReceive(pressQ, &b, pdMS_TO_TICKS(25)) == pdTRUE) { sendPress(b); lastPoll = 0; }
      if (millis() - lastPoll > 600) { lastPoll = millis(); poll(); }
      if (WiFi.status() == WL_CONNECTED) { if (!ntpOn && saHave()) { saTimeStart(); ntpOn = true; } saWeatherTick(true); }
      continue;
    }
    if (g_usbMode) { g_usbMode = false; g_host = ""; g_status = ST_SEARCH; Serial.println("[usb] servidor sumiu do cabo: voltando ao Wi-Fi"); }
    portalTick(WiFi.status() == WL_CONNECTED, g_everUp);   // portal de Wi-Fi: abre sozinho se nunca conectou (ou pela serial: W)
    if (g_saMode) {   // MODO AUTÔNOMO: relógio e botões da casa inteligente; a cada 5 s procura o servidor de novo
      const bool wifi = WiFi.status() == WL_CONNECTED;
      if (wifi && !wasUp) { wasUp = true; g_everUp = true; esp_wifi_set_ps(WIFI_PS_NONE); }
      if (!wifi) { wasUp = false; ntpOn = false; }
      if (wifi && !ntpOn) { saTimeStart(); ntpOn = true; }
      saWeatherTick(wifi);
      { SlideEv se; while (xQueueReceive(slideQ, &se, 0) == pdTRUE) {} }
      int b; while (xQueueReceive(pressQ, &b, pdMS_TO_TICKS(100)) == pdTRUE) { if (b >= PRESS_LONG) b -= PRESS_LONG; if (b >= 0) saPress(b); }   // sem servidor: segurar = tocar; deslizar não faz nada
      if (wifi && millis() - lastProbe > 5000) { lastProbe = millis(); g_host = ""; if (discover() && probeServer()) { saLeave(); lastPoll = 0; } else g_host = ""; }
      continue;
    }
    if (WiFi.status() != WL_CONNECTED) {
      if (wasUp) { wasUp = false; ntpOn = false; g_host = ""; g_status = ST_SEARCH; Serial.println("[wifi] caiu"); }
      if (millis() - lastLog > 10000) { lastLog = millis(); Serial.printf("[wifi] conectando... (status %d)\n", (int)WiFi.status()); }
      nap(300); continue;
    }
    if (!wasUp) { wasUp = true; g_everUp = true; esp_wifi_set_ps(WIFI_PS_NONE); Serial.printf("[wifi] conectado, ip %s (RAM interna %uK)\n", WiFi.localIP().toString().c_str(), (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024)); }
    if (!ntpOn && saHave()) { saTimeStart(); ntpOn = true; }
    saWeatherTick(true);
    if (!g_host.length()) { if (!discover()) { nap(2500); continue; } }
    if (!g_tok.length()) g_status = ST_UNPAIRED;
    if (g_status == ST_UNPAIRED) {   // tenta o pareamento a cada 2,5 s; toques não fazem nada até parear
      int d; while (xQueueReceive(pressQ, &d, 0) == pdTRUE) { strlcpy(g_toastPend, "Placa nao pareada: clique em Parear no Mac", sizeof g_toastPend); g_toastReady = 2; }
      tryPair(); if (g_status == ST_UNPAIRED) nap(2500); lastPoll = 0; continue;
    }
    { SlideEv se; while (xQueueReceive(slideQ, &se, 0) == pdTRUE) if (g_host.length()) sendSlide(se); }
    int b;
    while (xQueueReceive(pressQ, &b, pdMS_TO_TICKS(25)) == pdTRUE) { if (g_host.length()) { sendPress(b); lastPoll = 0; } }   // após um toque, relê a página já (pode ter mudado)
    if (g_host.length() && millis() - lastPoll > 1500) { lastPoll = millis(); poll(); }
  }
}

// ---------------- Tela do portal de Wi-Fi (Core 1) ----------------
// Cobre a tela inteira (lv_layer_top) enquanto o portal está aberto: QR code para entrar na rede da placa, instruções e a situação. O texto evita acentos (como o resto da tela).
static lv_obj_t *g_pOv = nullptr, *g_pMsg = nullptr; static PortalView g_pv = {};
static lv_obj_t *pLabel(lv_obj_t *par, const char *txt, int x, int y, int w, int px, uint32_t color) {
  lv_obj_t *l = lv_label_create(par); lv_obj_set_style_text_font(l, fontFor(px), 0); lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
  lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP); lv_obj_set_width(l, w); lv_label_set_text(l, txt); lv_obj_set_pos(l, x, y); return l;
}
static void portalUi() {
  if (!portalView(&g_pv)) return;
  if (!g_pv.on) { if (g_pOv) { lv_obj_delete(g_pOv); g_pOv = nullptr; g_pMsg = nullptr; } return; }
  if (!g_pOv) {
    lv_obj_t *ov = g_pOv = lv_obj_create(lv_layer_top()); lv_obj_set_size(ov, BOARD.w, BOARD.h); lv_obj_set_pos(ov, 0, 0);
    lv_obj_set_style_bg_color(ov, lv_color_hex(0x16171B), 0); lv_obj_set_style_bg_opa(ov, LV_OPA_COVER, 0); lv_obj_set_style_border_width(ov, 0, 0); lv_obj_set_style_radius(ov, 0, 0);
    lv_obj_set_style_pad_all(ov, 0, 0); lv_obj_remove_flag(ov, LV_OBJ_FLAG_SCROLLABLE);
    pLabel(ov, "Configurar o Wi-Fi da placa", 12, 8, BOARD.w - 24, 16, 0x19D9C8);
    char q[80]; snprintf(q, sizeof q, "WIFI:T:WPA;S:%s;P:%s;;", g_pv.ssid, g_pv.pass);   // o celular entra na rede da placa ao ler o QR
    lv_obj_t *qr = lv_qrcode_create(ov); lv_qrcode_set_size(qr, 116); lv_qrcode_set_dark_color(qr, lv_color_hex(0x111111)); lv_qrcode_set_light_color(qr, lv_color_hex(0xFFFFFF));
    lv_qrcode_update(qr, q, strlen(q)); lv_obj_set_pos(qr, 12, 40); lv_obj_set_style_border_color(qr, lv_color_white(), 0); lv_obj_set_style_border_width(qr, 4, 0);
    char t[256]; snprintf(t, sizeof t, "1. Aponte a camera do celular para o QR (ou entre na rede)\n%s\nsenha: %s\n\n2. Abra 192.168.4.1 se a pagina nao abrir sozinha\n\n3. Toque na sua rede e digite a senha", g_pv.ssid, g_pv.pass);
    pLabel(ov, t, 142, 40, BOARD.w - 154, 12, 0xECEEF2);
    g_pMsg = pLabel(ov, "", 12, 164, 124, 12, 0xFFB300);   // sob o QR (a coluna da direita é o texto das instruções)
    lv_obj_t *b = lv_button_create(ov); lv_obj_set_size(b, 84, 28); lv_obj_set_pos(b, BOARD.w - 96, BOARD.h - 38); lv_obj_set_style_bg_color(b, lv_color_hex(0x2C2F37), 0);
    lv_obj_add_event_cb(b, [](lv_event_t *) { portalDismiss(); }, LV_EVENT_CLICKED, NULL);
    lv_obj_t *bl = lv_label_create(b); lv_obj_set_style_text_font(bl, fontFor(12), 0); lv_label_set_text(bl, "Fechar"); lv_obj_center(bl);
  }
  if (g_pMsg) lv_label_set_text(g_pMsg, g_pv.msg);
}

// ---------------- Modo autônomo (Core 1): relógio de mesa ----------------
// Tela cheia sobre a grade (lv_layer_top): hora grande, data, clima (ícone + temperatura + descrição). Tocar mostra a grade do perfil; sem toque por `idleS` segundos volta ao relógio.
static lv_obj_t *g_ckOv = nullptr, *g_ckTime, *g_ckDate, *g_ckIcon, *g_ckTemp, *g_ckCond, *g_ckCity, *g_ckHint;
static lv_image_dsc_t g_ckDsc; static bool g_ckVisible = false; static uint32_t g_ckTick = 0, g_ckWVer = 0, g_ckUiVer = 0;
static lv_font_t *bigFont(int px) {
  static lv_font_t *f = nullptr; static int sz = 0;
  if (!f || sz != px) { f = lv_tiny_ttf_create_data(montserrat_ttf, montserrat_ttf_len, px); sz = px; if (f) f->fallback = (lv_font_t *)&lv_font_montserrat_14; }
  return f ? f : fontFor(24);
}
static const char *WD_PT[7] = {"dom", "seg", "ter", "qua", "qui", "sex", "sáb"}, *WD_EN[7] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char *MO_PT[12] = {"jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"}, *MO_EN[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
static void clockText(char *tm, size_t tn, char *dt, size_t dn) {
  if (!saTimeValid()) { strlcpy(tm, "--:--", tn); dt[0] = 0; return; }
  time_t now = time(nullptr); struct tm t; localtime_r(&now, &t);
  char sec[8] = ""; if (g_saUi.seconds) snprintf(sec, sizeof sec, ":%02d", t.tm_sec);
  if (g_saUi.h24) snprintf(tm, tn, "%02d:%02d%s", t.tm_hour, t.tm_min, sec); else { int h = t.tm_hour % 12; if (!h) h = 12; snprintf(tm, tn, "%d:%02d%s %s", h, t.tm_min, sec, t.tm_hour < 12 ? "AM" : "PM"); }
  if (g_saUi.en) snprintf(dt, dn, "%s, %s %d", WD_EN[t.tm_wday], MO_EN[t.tm_mon], t.tm_mday); else snprintf(dt, dn, "%s, %d %s", WD_PT[t.tm_wday], t.tm_mday, MO_PT[t.tm_mon]);
}
static int nightBrightness() {   // 255 normal; no horário noturno e sem toque há 30 s, o brilho escolhido
  if (!g_saUi.night || !saTimeValid() || millis() - g_lastTouch < 30000) return 255;
  time_t now = time(nullptr); struct tm t; localtime_r(&now, &t); const int m = t.tm_hour * 60 + t.tm_min, f = g_saUi.nightFrom, e = g_saUi.nightTo;
  const bool in = f <= e ? (m >= f && m < e) : (m >= f || m < e);
  return in ? max(8, g_saUi.nightPct * 255 / 100) : 255;
}
static void ckRefresh() {   // textos que dependem do perfil/clima
  if (!g_ckOv) return;
  lv_label_set_text(g_ckHint, g_saUi.tTouch);
  const bool has = g_saUi.weather && g_wValid;
  for (lv_obj_t *o : {g_ckIcon, g_ckTemp, g_ckCond}) { if (has) lv_obj_remove_flag(o, LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN); }
  if (g_saUi.weather) lv_label_set_text(g_ckCity, g_saUi.city); else lv_label_set_text(g_ckCity, "");
  if (has) {
    const int k = constrain((int)g_wKind, 0, 7); char b[16]; snprintf(b, sizeof b, "%d°%c", (int)g_wTemp, g_saUi.units == 'f' ? 'F' : 'C');
    lv_label_set_text(g_ckTemp, b); lv_label_set_text(g_ckCond, g_saUi.kind[k]);
    if (g_saIcon[k]) { g_ckDsc = {}; g_ckDsc.header.magic = LV_IMAGE_HEADER_MAGIC; g_ckDsc.header.cf = LV_COLOR_FORMAT_RGB565; g_ckDsc.header.w = 48; g_ckDsc.header.h = 48; g_ckDsc.header.stride = 96; g_ckDsc.data_size = 48 * 48 * 2; g_ckDsc.data = g_saIcon[k]; lv_image_cache_drop(&g_ckDsc); lv_image_set_src(g_ckIcon, &g_ckDsc); lv_obj_invalidate(g_ckIcon); }
  } else if (g_saUi.weather) { lv_label_set_text(g_ckCond, g_saUi.tNoData); lv_obj_remove_flag(g_ckCond, LV_OBJ_FLAG_HIDDEN); }
  lv_obj_align(g_ckCity, LV_ALIGN_BOTTOM_MID, 0, -26);
  lv_obj_update_layout(g_ckOv);   // o tamanho dos textos só existe depois do layout: só então alinha ao lado do ícone (antes, temperatura e descrição se sobrepunham)
  lv_obj_align_to(g_ckTemp, g_ckIcon, LV_ALIGN_OUT_RIGHT_TOP, 12, 2); lv_obj_align_to(g_ckCond, g_ckIcon, LV_ALIGN_OUT_RIGHT_BOTTOM, 12, -2);
}
static void ckShow(bool on) { g_ckVisible = on; if (!g_ckOv) return; if (on) lv_obj_remove_flag(g_ckOv, LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(g_ckOv, LV_OBJ_FLAG_HIDDEN); }
static void saUiBuild() {
  if (g_ckOv) return;
  lv_obj_t *ov = g_ckOv = lv_obj_create(lv_layer_top()); lv_obj_set_size(ov, BOARD.w, BOARD.h); lv_obj_set_pos(ov, 0, 0); lv_obj_move_to_index(ov, 0);   // sob o portal de Wi-Fi, se ele abrir
  lv_obj_set_style_bg_color(ov, lv_color_hex(0x16161A), 0); lv_obj_set_style_bg_opa(ov, LV_OPA_COVER, 0); lv_obj_set_style_border_width(ov, 0, 0); lv_obj_set_style_radius(ov, 0, 0); lv_obj_set_style_pad_all(ov, 0, 0);   // mesmo fundo dos ícones do clima (o servidor os desenha sobre #16161A)
  lv_obj_remove_flag(ov, LV_OBJ_FLAG_SCROLLABLE); lv_obj_add_flag(ov, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(ov, [](lv_event_t *) { ckShow(false); g_lastTouch = millis(); }, LV_EVENT_CLICKED, NULL);   // tocar mostra a grade de botões
  auto mk = [&](int px, uint32_t color) { lv_obj_t *l = lv_label_create(ov); lv_obj_set_style_text_font(l, px > 24 ? bigFont(px) : fontFor(px), 0); lv_obj_set_style_text_color(l, lv_color_hex(color), 0); lv_obj_remove_flag(l, LV_OBJ_FLAG_CLICKABLE); lv_label_set_text(l, ""); return l; };
  g_ckTime = mk(BOARD.h >= 200 ? 76 : 56, 0xF4F4F6); lv_obj_align(g_ckTime, LV_ALIGN_TOP_MID, 0, 14);
  g_ckDate = mk(18, 0x9AA0AE); lv_obj_align(g_ckDate, LV_ALIGN_TOP_MID, 0, BOARD.h >= 200 ? 100 : 80);
  g_ckIcon = lv_image_create(ov); lv_obj_remove_flag(g_ckIcon, LV_OBJ_FLAG_CLICKABLE); lv_obj_align(g_ckIcon, LV_ALIGN_LEFT_MID, BOARD.w / 2 - 92, BOARD.h >= 200 ? 28 : 14);
  g_ckTemp = mk(24, 0xF4F4F6); lv_obj_align_to(g_ckTemp, g_ckIcon, LV_ALIGN_OUT_RIGHT_TOP, 12, 0);
  g_ckCond = mk(14, 0x9AA0AE); lv_obj_align_to(g_ckCond, g_ckIcon, LV_ALIGN_OUT_RIGHT_BOTTOM, 12, 0);
  g_ckCity = mk(12, 0x6B7280); g_ckHint = mk(12, 0x4B5563); lv_obj_align(g_ckHint, LV_ALIGN_BOTTOM_MID, 0, -8);
  ckRefresh();
}
static void saUiTick() {   // Core 1, a cada volta do loop
  const uint8_t req = g_saUiReq;
  if (req == 1) { g_saUiReq = 0; saUiBuild(); ckShow(true); g_lastTouch = millis(); }
  else if (req == 2) { g_saUiReq = 0; if (g_ckOv) { lv_obj_delete(g_ckOv); g_ckOv = nullptr; } g_ckVisible = false; }
  if (!g_saMode || !g_ckOv) return;
  const uint32_t now = millis();
  if (g_ckUiVer != g_saUiVer || g_ckWVer != g_wVer) { g_ckUiVer = g_saUiVer; g_ckWVer = g_wVer; ckRefresh(); }
  if (now - g_ckTick >= 250) {
    g_ckTick = now; char tm[24], dt[32]; clockText(tm, sizeof tm, dt, sizeof dt);
    if (g_ckVisible) { if (strcmp(lv_label_get_text(g_ckTime), tm)) lv_label_set_text(g_ckTime, tm); if (strcmp(lv_label_get_text(g_ckDate), dt)) lv_label_set_text(g_ckDate, dt); lv_obj_align(g_ckTime, LV_ALIGN_TOP_MID, 0, 14); lv_obj_align(g_ckDate, LV_ALIGN_TOP_MID, 0, BOARD.h >= 200 ? 100 : 80); }
    for (int i = 0; i < g_ui.n; i++) {   // botões Relógio/Clima da grade
      if (!g_wl[i] || !g_ui.t[i].wd) continue; char b[32];
      if (g_ui.t[i].wd == 1) strlcpy(b, tm, sizeof b); else if (g_wValid) snprintf(b, sizeof b, "%d°%c", (int)g_wTemp, g_saUi.units == 'f' ? 'F' : 'C'); else strlcpy(b, "--", sizeof b);
      if (strcmp(lv_label_get_text(g_wl[i]), b)) { lv_label_set_text(g_wl[i], b); lv_obj_center(g_wl[i]); }
    }
  }
  if (!g_ckVisible && now - g_lastTouch > (uint32_t)max(5, g_saUi.idleS) * 1000UL) ckShow(true);   // sem toque: volta ao relógio
  g_blTarget = nightBrightness();   // no modo autônomo o brilho é daqui (no normal vem do servidor)
}

void setup() {
  Serial.setRxBufferSize(16384);   // fila de RX da USB: se encher, o hardware descarta bytes (o cabo manda imagens de 12 KB em sequência)
  Serial.begin(115200); delay(300);
  Serial.println("\n=== Stream Deck ES3C28P ===");
  heap_caps_malloc_extmem_enable(512);   // alocações >= 512 B vão para a PSRAM (nunca < 512: quebra o serial)
  { esp_task_wdt_config_t w = {}; w.timeout_ms = 10000; w.idle_core_mask = (1 << 1); w.trigger_panic = true; esp_task_wdt_reconfigure(&w); }
  boardInit();   // pinos de energia, I2C, toque e backlight apagado (src/board_<nome>.cpp)
  Serial.printf("[placa] %s %dx%d %d ppi\n", BOARD.name, BOARD.w, BOARD.h, BOARD.ppi);
  prefs.begin("deck", false); g_tok = prefs.getString("tok", "");
  g_imgMux = xSemaphoreCreateMutex();
  saInit(); saLoadProfile(); execSetCallback(execDone);   // perfil do modo autônomo (flash) e retorno das ações de rede
  g_pollBuf = (uint8_t *)heap_caps_malloc(POLL_CAP, MALLOC_CAP_SPIRAM); usbLinkInit();
  makeUniform(g_ui, 4, 2, 73, 96, 32, 12, 36); g_net = g_ui; g_pendGeom = g_ui;   // grade inicial 4x2 até o servidor mandar a lista
  allocImages(g_ui);   // imagens na PSRAM para a grade inicial; começam com fundo escuro até o Mac mandar as reais
  for (int i = 0; i < 8; i++) strlcpy(g_labelCur[i], DEMO_LABELS[i], sizeof g_labelCur[i]);
  for (int i = 0; i < MAXBTN; i++) g_fsCur[i] = 12;
  pressQ = xQueueCreate(4, sizeof(int)); slideQ = xQueueCreate(8, sizeof(SlideEv));

  lv_init(); lv_tick_set_cb((lv_tick_get_cb_t)millis);
  g_disp = lv_display_create(SW, SH);
  boardDisplayInit(g_disp);   // painel, buffers e flush (src/board_<nome>.cpp)
  lv_indev_t *in = lv_indev_create(); lv_indev_set_type(in, LV_INDEV_TYPE_POINTER); lv_indev_set_read_cb(in, touch_cb);

  lv_obj_add_event_cb(lv_screen_active(), evGesture, LV_EVENT_GESTURE, NULL);
  buildUi();
  lv_timer_handler(); lv_refr_now(g_disp); while (!boardFlushIdle()) delay(1);
  fadeBacklight(255);
  Serial.printf("[heap] interna %uK  psram %uK\n", (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024), (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
  xTaskCreatePinnedToCore(netTask, "net", 10 * 1024, NULL, 1, NULL, 0);   // pilha interna: o Wi-Fi/NVS pode gravar em flash
}

static void powerOff() {   // Core 1: apaga tudo e entra em deep sleep sem nenhuma fonte de despertar (só o RESET/EN liga de novo)
  Serial.println("[energia] desligando (RESET para voltar)"); Serial.flush();
  fadeBacklight(0); boardPowerOff();
  WiFi.disconnect(true, false); WiFi.mode(WIFI_OFF);
  esp_deep_sleep_start();
}

void loop() {
  if (g_powerOff) powerOff();
  { int want = g_scrOff ? 0 : g_blTarget; if (want != g_bl) fadeBacklight(want); }   // brilho/apagar pedido pelo servidor ou toque de acordar
  applyPending(); animTick(); portalUi(); saUiTick();
  uint32_t d = lv_timer_handler();
  static uint32_t lastP = 0;
  if (millis() - lastP > 15000) { lastP = millis(); Serial.printf("[dbg] status=%d host=%s wifi=%d psram=%uK anim=%uK interna=%uK maior=%uK\n", (int)g_status, g_host.c_str(), (int)WiFi.status(), (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024), (unsigned)(g_animUsed / 1024),
                                    (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024), (unsigned)(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL) / 1024)); }
  // comandos de teste pelo serial (lidos pela task do usblink e entregues por usbCmd()): T x,y toque virtual; P captura da tela (RGB565); H a.b.c.d fixa o endereço do Mac (H - limpa); S estado; W abre o portal de Wi-Fi; K esquece a chave de acesso
  while (usbCmd().available()) {
    char c = usbCmd().read();
    if (c == 'T') { int x = usbCmd().parseInt(), y = usbCmd().parseInt(); g_injX = x; g_injY = y; g_injUntil = millis() + 160; continue; }
    if (c == 'H') { String h = usbCmd().readStringUntil('\n'); h.trim(); if (h == "-") { prefs.remove("host"); Serial.println("[cfg] endereco fixo removido"); } else if (h.length() > 6) { prefs.putString("host", h); Serial.printf("[cfg] endereco fixo: %s\n", h.c_str()); } g_host = ""; continue; }
    if (c == 'X') { g_saMode = false; g_saUiReq = 2; saClear(); continue; }   // X: apaga o perfil do modo autônomo (tokens e senhas da flash)
    if (c == 'K') { prefs.remove("tok"); g_tok = ""; Serial.println("[cfg] chave de acesso apagada (placa volta a precisar de pareamento)"); continue; }
    if (c == 'W') { portalForce(); Serial.println("[portal] aberto pela serial"); continue; }
    if (c == 'S') { Serial.printf("[estado] status=%d host=%s:%u fixo=%s\n", (int)g_status, g_host.c_str(), g_port, prefs.getString("host", "-").c_str()); continue; }
    if (c == 'P') {
      lv_draw_buf_t *sn = lv_snapshot_take(g_pOv ? g_pOv : (g_ckOv && g_ckVisible) ? g_ckOv : lv_screen_active(), LV_COLOR_FORMAT_RGB565);   // portal, relógio do modo autônomo ou a tela ativa
      if (sn) {
        uint32_t w = sn->header.w, h = sn->header.h, st = sn->header.stride;
        Serial.printf("\n[snap] %u %u %u\n", (unsigned)w, (unsigned)h, (unsigned)(w * h * 2));
        for (uint32_t y = 0; y < h; y++) { Serial.write(sn->data + y * st, w * 2); if ((y & 15) == 15) Serial.flush(); }
        Serial.flush(); Serial.printf("\n[snap-end]\n"); lv_draw_buf_destroy(sn);
      } else Serial.println("[snap] falhou");
    }
  }
  delay(constrain(d, 1, 6));
}
