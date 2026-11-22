# LVGL on the ES3C28P: what we measured (LVGL 9.6, ESP32-S3 at 240 MHz)

*[Português](../../hardware/LVGL-DESEMPENHO.md)*

## Display driver
- TFT_eSPI + DMA does NOT work on the S3 with Arduino core 3.x (black screen after the first block). Without DMA it works but is slow.
- Solution: `esp_lcd` directly (spi_bus_initialize SPI3 + `esp_lcd_new_panel_io_spi` + manual ILI9341 init + `esp_lcd_panel_io_tx_color`).
  `on_color_trans_done` calls `lv_display_flush_ready` (ISR): truly asynchronous DMA, 2 buffers of 320x60 in internal RAM.
- SPI at 80 MHz is NOT suitable: it does not speed anything up (the bottleneck is the CPU) and leaves the image with cut/corrupted areas that only fix themselves on redraw (confirmed in practice). 40 MHz = safe limit, clean image (confirmed).
- QIO flash mode (vs DIO) did not change render time. `dio_opi` kept.

## Honest core-load measurement
- Without `lv_display_set_flush_wait_cb`, LVGL waits for the DMA in a busy loop: Core 1 shows ~99% while doing no work.
  With a wait_cb sleeping on a semaphore (given by the ISR), the same panel dropped to ~26% and then ~16%.
- The reported FPS = real updates per second, not the ceiling. Ceiling = 1 / (render+send time per frame).

## What is expensive (and how to avoid it)
- Cost ≈ number of draw operations + invalidated areas, not just pixels (~1.2 to 1.7 µs/px in the tests).
- `lv_label_set_text`/`lv_arc_set_value` redraw even with an equal value: only update when it changed (helpers setFmt/setArc/setBar).
  Panel: 22.5 -> 7.5 ms per frame and 13k -> 3.6k px per frame.
- Moving many objects with `lv_obj_set_x` is costly (layout + 1 invalidation per object; above ~32 invalidated areas
  LVGL falls back to a full-screen redraw). Better: one object with `LV_EVENT_DRAW_MAIN_END` and `lv_draw_rect` for each dot + 1 invalidation timer.
  Result: 40 objects = 49 fps, 80 objects = 35 fps (Core 1 at ~95%, render-bound).
- The `colorwheel` widget does not exist in LVGL 9: use an RGB565 canvas in PSRAM.
- Menu: `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=4096` in Arduino: malloc >= 4 KB goes to PSRAM (slow for DMA/render).
  DMA buffers: `heap_caps_malloc(MALLOC_CAP_DMA|MALLOC_CAP_INTERNAL)`.
