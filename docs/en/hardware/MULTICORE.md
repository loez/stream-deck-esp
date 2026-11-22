# Using the ESP32-S3's 2 cores (research)

*[Português](../../hardware/MULTICORE.md)*

ESP32-S3 = 2 Xtensa LX7 cores at 240 MHz: Core 0 = PRO_CPU, Core 1 = APP_CPU. FreeRTOS in SMP mode (IDF).

## Facts (with sources)
- Espressif convention: network/radio tasks (Wi-Fi, BT) live on Core 0; the application on Core 1.
  `xTaskCreatePinnedToCore(fn, name, stack, arg, prio, &handle, core)`: core 0, 1 or `tskNO_AFFINITY`.
  A plain `xTaskCreate()` = no affinity (the task may migrate between cores).
  Source: https://docs.espressif.com/projects/esp-idf/en/v4.4.7/api-guides/freertos-smp.html
- On Arduino-ESP32 `loop()` runs in `loopTask`, priority 1, pinned to Core 1 (stack 8192); the Wi-Fi radio runs on Core 0.
  The `ARDUINO_EVENT_RUNNING_CORE` symbol was NOT confirmed; check the code of the version in use.
  Sources (community, unofficial): https://randomnerdtutorials.com/esp32-dual-core-arduino-ide/ and https://api-docs.esphome.io/esp32_2core_8cpp_source
- Disabling interrupts only affects the current core: it is NOT mutual exclusion between cores. Use a spinlock
  (`portMUX_TYPE` + `taskENTER_CRITICAL(&mux)`), short critical sections, no FreeRTOS API calls or blocking inside, and watch for deadlock with nested locks.
  For larger data: mutex/semaphore, queues, stream/message buffers, task notifications.
  Source: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/freertos_idf.html
- `CONFIG_FREERTOS_UNICORE` on an S3 makes the application run only on Core 0 (it is not "vanilla" FreeRTOS; there is still SMP overhead). Same source as above.
- Watchdog (TWDT): by default it watches the IDLE task of each core. A high-priority task that never yields the CPU stops that core's IDLE
  from feeding the watchdog and causes a reset. Fix: block/`vTaskDelay`, shorten the work, or raise the timeout.
  Source: https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/system/wdts.html
- SPI/DMA display: Espressif recommends keeping the SPI ISR and the LVGL task on the SAME core (`isr_cpu_id` / task affinity).
  Source: https://docs.espressif.com/projects/esp-faq/en/latest/software-framework/peripherals/lcd.html
- WARNING (unresolved report, Jul/2026): INT_WDT freeze on dual-core S3 correlated with LVGL flush over SPI GDMA; it went away with the second core disabled.
  If a reset/freeze shows up with the display, test with the display on the same core as the ISR and compare with unicore.
  Source: https://esp32.com/viewtopic.php?p=155275
- I found no source with recommended priority values for UI x audio x network: treat the below as a PROPOSAL to validate by measuring.

## Proposed split for this board (to validate by measurement)
| Core | Loads | Reason |
|---|---|---|
| Core 0 | Wi-Fi/network (HTTP streams, MQTT), SD reading, input buffers | stays next to the radio; blocking I/O does not delay UI/audio |
| Core 1 | UI (`loop`/LVGL), display SPI and touch, decoding + I2S output | predictable latency for screen and audio |
Practical rules:
1. Communicate between cores with queues/ring buffers (stream buffer for audio), never loose variables; `volatile` is not enough for composite data.
2. Audio needs a large DMA buffer (>= 4-8 buffers) and a task with higher priority than the UI; the UI never blocks the audio loop.
3. Every looping task must block (delay, queue, notification) so as not to starve IDLE and trigger the TWDT.
4. Stack per task: start with 4-8 KB (MP3/AAC decoder: 16 KB+), measure with `uxTaskGetStackHighWaterMark`.
5. Large buffers (audio, framebuffer, network) in PSRAM (8 MB) with `heap_caps_malloc(MALLOC_CAP_SPIRAM)`; DMA requires internal memory.
6. Measure before optimizing: `vTaskGetRunTimeStats` / count cycles per core; only move a task if there is a real gain.
7. Do not share the I2C bus (touch 0x38 + codec 0x18, same bus) between cores without a mutex.
8. If audio is ever added: keep the audio task on Core 1 with the UI and the network on Core 0.
