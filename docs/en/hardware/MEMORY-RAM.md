# Internal RAM is the scarce resource (measurements on the ES3C28P)

*[Português](../../hardware/MEMORIA-RAM.md)*

ESP32-S3 with 8 MB of PSRAM, but **internal** RAM (~330 KB usable) runs out fast with Wi-Fi + LVGL + TLS (+ audio, if you ever add it).

## Typical budget (free internal RAM)
Measured in a demo app with Wi-Fi, LVGL and TLS on the same board:

| Stage | Free |
|---|---|
| app start | 277 KB |
| after LVGL + display (2 DMA buffers) | ~200 KB |
| UI ready (3 screens, TTF fonts) | ~164 KB |
| after Wi-Fi connected | ~90 KB (Wi-Fi alone costs ~90 KB) |
| one HTTPS session (with TLS in PSRAM) | ~70 KB (stable, no leak) |

Without the measures below, the first version dropped to 6 KB free and aborted (`ESP_ERR_NO_MEM` in `phy_track_pll_init`), and a single TLS session took RAM down to 11 KB.
In Stream Deck, standalone mode measures ~115 KB free before entering and ~64 KB while in it (see [STANDALONE-MODE.md](../STANDALONE-MODE.md)).

## Measures that worked
1. `heap_caps_malloc_extmem_enable(512)` at the start of `setup()`: malloc >= 512 B goes to PSRAM (the framework default is 4096).
2. TLS in PSRAM: `-Wl,--wrap=esp_mbedtls_mem_calloc` + `__wrap_esp_mbedtls_mem_calloc` with `heap_caps_calloc(MALLOC_CAP_SPIRAM)`
   (the framework builds mbedtls with `MBEDTLS_INTERNAL_MEM_ALLOC`; each HTTPS session uses ~50 KB of internal RAM).
3. Large task stacks in PSRAM: `xTaskCreatePinnedToCoreWithCaps(..., MALLOC_CAP_SPIRAM)` (`freertos/idf_additions.h`).
   Do NOT put in PSRAM tasks that write to flash/NVS (e.g. the one that calls `WiFi.begin(ssid, password)`).
4. Small LVGL render buffers (2 x 320x24 in internal/DMA RAM) and TTF fonts with a small glyph cache (`LV_TINY_TTF_CACHE_GLYPH_CNT`).
5. Large lists with `heap_caps_calloc(MALLOC_CAP_SPIRAM)`; ArduinoJson with a filter.

## The "goes back to the home screen" crash
Symptom: the app rebooted in the middle of a network operation. Cause: `ESP_ERR_NO_MEM` in `esp_timer_create` called by `phy_track_pll_init`
(chain: ppTask -> pm_wake_up -> esp_phy_enable). It was a **transient peak** of internal RAM: a 40-item list cost ~47 KB
(hundreds of small LVGL objects) and added up with the Wi-Fi buffer peak while downloading a JSON -> it reached 3 KB free.
Fixes, in order of impact:
1. **Whole LVGL heap in PSRAM** (`LV_USE_STDLIB_MALLOC LV_STDLIB_CUSTOM` + `src/lv_mem_psram.cpp` with `heap_caps_malloc(MALLOC_CAP_SPIRAM)`).
   Free internal RAM went from 48-95 KB (fluctuating) to a **steady 156-159 KB**, 0 reboots in 22 stress steps.
2. ArduinoJson with its own allocator in PSRAM (`JsonDocument doc(&psramAlloc)`): the JSON produced thousands of small internal allocations.
3. `esp_wifi_set_ps(WIFI_PS_NONE)` on connect (only `WiFi.setSleep(false)` before begin was not enough: the log still showed pm_wake_up).
4. Less data per request.

TRAP: `heap_caps_malloc_extmem_enable(128)` broke **receiving commands over the USB serial** (no command was answered).
It works with 512. Do not use a threshold < 512 without testing the serial.

## How to measure
`heapLog(tag)` prints free internal RAM, the largest contiguous block and PSRAM. The largest block matters as much as the total (fragmentation).

## If you add audio (lessons from a previous project on the same board)
- The UI competes for CPU and bus with the decoder. The metric that worked: **PCM blocks per second** in the I2S output hook (real time at 44.1 kHz = 172/s).
- Avoid scrolling text (marquee) and animations that keep the UI at dozens of frames per second while audio plays.
- A hybrid LVGL allocator (`lv_mem_psram.cpp`: small blocks in internal RAM while there is headroom, the rest in PSRAM) helps throughput.
- The network/IO task that shares a core with the decoder should have **lower** priority than the decoder and not wake on every tick (a `vTaskDelay` of a few ms).
