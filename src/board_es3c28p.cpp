// Placa LCDWiki ES3C28P (ESP32-S3, ILI9341V 240x320 por SPI, toque FT6336G, 2,8"): ver docs/hardware/ES3C28P.md. Paisagem 320x240, ~143 ppi.
#include "board.h"
#include <Wire.h>
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_io_spi.h"
#include "freertos/idf_additions.h"
#include "esp_heap_caps.h"
#include "driver/gpio.h"

#define PIN_I2C_SDA 16
#define PIN_I2C_SCL 15
#define PIN_TOUCH_RST 18
#define PIN_BL 45
#define LCD_HZ 40000000   // 80 MHz corrompe a imagem neste painel

const BoardInfo BOARD = {"ES3C28P", 320, 240, 143, 1000000};   // SPI 40 MHz = ~1,7 Mpx/s de RGB565; ~1,0 Mpx/s úteis para animação
#define SW (BOARD.w)
#define SH (BOARD.h)

// ---------------- Display (esp_lcd, SPI3 + DMA assíncrono) ----------------
static esp_lcd_panel_io_handle_t lcdIo;
static SemaphoreHandle_t flushSem; static volatile bool flushBusy;

static bool onColorDone(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t *, void *ctx) {
  BaseType_t hp = pdFALSE; flushBusy = false;
  lv_display_flush_ready((lv_display_t *)ctx);
  xSemaphoreGiveFromISR(flushSem, &hp); return hp == pdTRUE;
}
static void flushWait_cb(lv_display_t *) { while (flushBusy) xSemaphoreTake(flushSem, pdMS_TO_TICKS(2)); }
static void lcdCmd(uint8_t c, std::initializer_list<uint8_t> d = {}) {
  esp_lcd_panel_io_tx_param(lcdIo, c, d.size() ? d.begin() : nullptr, d.size());
}
static void lcdInit(lv_display_t *disp) {
  spi_bus_config_t bus = {};
  bus.mosi_io_num = 11; bus.miso_io_num = -1; bus.sclk_io_num = 12; bus.quadwp_io_num = -1; bus.quadhd_io_num = -1;
  bus.max_transfer_sz = SW * 60 * 2 + 16;
  ESP_ERROR_CHECK(spi_bus_initialize(SPI3_HOST, &bus, SPI_DMA_CH_AUTO));
  esp_lcd_panel_io_spi_config_t io = {};
  io.cs_gpio_num = (gpio_num_t)10; io.dc_gpio_num = (gpio_num_t)46; io.spi_mode = 0; io.pclk_hz = LCD_HZ; io.trans_queue_depth = 10;
  io.lcd_cmd_bits = 8; io.lcd_param_bits = 8; io.on_color_trans_done = onColorDone; io.user_ctx = disp;
  ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI3_HOST, &io, &lcdIo));
  lcdCmd(0x01); delay(150);
  lcdCmd(0xEF, {0x03, 0x80, 0x02}); lcdCmd(0xCF, {0x00, 0xC1, 0x30}); lcdCmd(0xED, {0x64, 0x03, 0x12, 0x81});
  lcdCmd(0xE8, {0x85, 0x00, 0x78}); lcdCmd(0xCB, {0x39, 0x2C, 0x00, 0x34, 0x02}); lcdCmd(0xF7, {0x20}); lcdCmd(0xEA, {0x00, 0x00});
  lcdCmd(0xC0, {0x23}); lcdCmd(0xC1, {0x10}); lcdCmd(0xC5, {0x3E, 0x28}); lcdCmd(0xC7, {0x86});
  lcdCmd(0x3A, {0x55}); lcdCmd(0xB1, {0x00, 0x18}); lcdCmd(0xB6, {0x08, 0x82, 0x27}); lcdCmd(0xF2, {0x00}); lcdCmd(0x26, {0x01});
  lcdCmd(0xE0, {0x0F, 0x31, 0x2B, 0x0C, 0x0E, 0x08, 0x4E, 0xF1, 0x37, 0x07, 0x10, 0x03, 0x0E, 0x09, 0x00});
  lcdCmd(0xE1, {0x00, 0x0E, 0x14, 0x03, 0x11, 0x07, 0x31, 0xC1, 0x48, 0x08, 0x0F, 0x0C, 0x31, 0x36, 0x0F});
  lcdCmd(0x36, {0x28}); lcdCmd(0x21);   // paisagem + inversão de cor (este painel exige)
  lcdCmd(0x11); delay(120); lcdCmd(0x29); delay(20);
}
static void flush_cb(lv_display_t *disp, const lv_area_t *a, uint8_t *px) {
  uint32_t w = a->x2 - a->x1 + 1, h = a->y2 - a->y1 + 1;
  lv_draw_sw_rgb565_swap(px, w * h);
  lcdCmd(0x2A, {(uint8_t)(a->x1 >> 8), (uint8_t)a->x1, (uint8_t)(a->x2 >> 8), (uint8_t)a->x2});
  lcdCmd(0x2B, {(uint8_t)(a->y1 >> 8), (uint8_t)a->y1, (uint8_t)(a->y2 >> 8), (uint8_t)a->y2});
  flushBusy = true;
  esp_lcd_panel_io_tx_color(lcdIo, 0x2C, px, w * h * 2);
}

void boardInit() {
  pinMode(1, OUTPUT); digitalWrite(1, HIGH);   // amplificador 8002E em shutdown (sem áudio)
  pinMode(PIN_BL, OUTPUT); analogWrite(PIN_BL, 0);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  pinMode(PIN_TOUCH_RST, OUTPUT); digitalWrite(PIN_TOUCH_RST, LOW); delay(10); digitalWrite(PIN_TOUCH_RST, HIGH); delay(100);
}
void boardDisplayInit(lv_display_t *disp) {
  flushSem = xSemaphoreCreateBinary();
  lv_display_set_flush_cb(disp, flush_cb); lv_display_set_flush_wait_cb(disp, flushWait_cb);
  lcdInit(disp);
  const size_t BUF = SW * 24 * 2;   // 24 linhas, buffer duplo na RAM interna (DMA)
  void *b1 = heap_caps_malloc(BUF, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL), *b2 = heap_caps_malloc(BUF, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  lv_display_set_buffers(disp, b1, b2, BUF, LV_DISPLAY_RENDER_MODE_PARTIAL);
}
bool boardFlushIdle() { return !flushBusy; }
void boardBacklight(int v) { analogWrite(PIN_BL, v); }
void boardPowerOff() {
  analogWrite(PIN_BL, 0); ledcDetach(PIN_BL); pinMode(PIN_BL, OUTPUT); digitalWrite(PIN_BL, LOW);
  gpio_hold_en((gpio_num_t)PIN_BL); gpio_deep_sleep_hold_en();   // backlight fica apagado durante o deep sleep
  lcdCmd(0x28); lcdCmd(0x10); delay(120);                         // ILI9341: display off + sleep in
}

// ---------------- Toque FT6336G: x = y_raw, y = 240 - x_raw (calibração medida, ver DISPOSITIVO.md) ----------------
bool boardTouch(int *x, int *y) {
  Wire.beginTransmission(0x38); Wire.write(0x02);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)0x38, (uint8_t)5) != 5) return false;
  uint8_t b[5]; for (int i = 0; i < 5; i++) b[i] = Wire.read();
  if ((b[0] & 0x0F) == 0) return false;
  int rx = ((b[1] & 0x0F) << 8) | b[2], ry = ((b[3] & 0x0F) << 8) | b[4];
  *x = constrain((ry - 10) * (SW - 1) / 299, 0, SW - 1); *y = constrain((SH - 1) - rx * (SH - 1) / 237, 0, SH - 1);
  return true;
}
