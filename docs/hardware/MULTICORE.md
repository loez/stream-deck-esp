# Uso dos 2 núcleos do ESP32-S3 (pesquisa)

*[English](../en/hardware/MULTICORE.md)*

ESP32-S3 = 2 núcleos Xtensa LX7 a 240 MHz: Core 0 = PRO_CPU, Core 1 = APP_CPU. FreeRTOS em modo SMP (IDF).

## Fatos (com fonte)
- Convenção da Espressif: tasks de rede/rádio (Wi-Fi, BT) ficam no Core 0; a aplicação, no Core 1.
  `xTaskCreatePinnedToCore(fn, nome, stack, arg, prio, &handle, core)`: core 0, 1 ou `tskNO_AFFINITY`.
  `xTaskCreate()` comum = sem afinidade (a task pode migrar entre núcleos).
  Fonte: https://docs.espressif.com/projects/esp-idf/en/v4.4.7/api-guides/freertos-smp.html
- No Arduino-ESP32 o `loop()` roda na `loopTask`, prioridade 1, fixada no Core 1 (stack 8192); o rádio Wi-Fi roda no Core 0.
  O símbolo `ARDUINO_EVENT_RUNNING_CORE` NÃO foi confirmado; verificar no código da versão usada.
  Fontes (comunidade, não oficiais): https://randomnerdtutorials.com/esp32-dual-core-arduino-ide/ e https://api-docs.esphome.io/esp32_2core_8cpp_source
- Desabilitar interrupções afeta só o núcleo atual: NÃO serve de exclusão mútua entre núcleos. Usar spinlock
  (`portMUX_TYPE` + `taskENTER_CRITICAL(&mux)`), seções críticas curtas, sem chamar API FreeRTOS/bloquear dentro, cuidado com deadlock em locks aninhados.
  Para dados maiores: mutex/semáforo, queues, stream/message buffers, task notifications.
  Fonte: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/freertos_idf.html
- `CONFIG_FREERTOS_UNICORE` num S3 faz a aplicação rodar só no Core 0 (não é FreeRTOS "vanilla"; ainda há overhead SMP). Mesma fonte acima.
- Watchdog (TWDT): por padrão vigia as tasks IDLE de cada núcleo. Task de prioridade alta que não cede o processador impede a IDLE
  daquele núcleo de alimentar o watchdog e causa reset. Solução: bloquear/dar `vTaskDelay`, encurtar trabalho, ou aumentar o timeout.
  Fonte: https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/system/wdts.html
- Display SPI/DMA: a Espressif recomenda manter a ISR do SPI e a task do LVGL no MESMO núcleo (`isr_cpu_id` / afinidade da task).
  Fonte: https://docs.espressif.com/projects/esp-faq/en/latest/software-framework/peripherals/lcd.html
- ALERTA (relato não resolvido, jul/2026): freeze INT_WDT em S3 dual-core correlacionado com flush LVGL via SPI GDMA; sumia ao desabilitar o 2º núcleo.
  Se aparecer reset/freeze com a tela, testar com o display no mesmo núcleo da ISR e comparar com unicore.
  Fonte: https://esp32.com/viewtopic.php?p=155275
- Não achei fonte com valores de prioridade recomendados para UI x áudio x rede: tratar abaixo como PROPOSTA a validar medindo.

## Proposta de divisão para esta placa (a validar por medição)
| Núcleo | Cargas | Motivo |
|---|---|---|
| Core 0 | Wi-Fi/rede (streams HTTP, MQTT), leitura do SD, buffers de entrada | fica junto do rádio; I/O que bloqueia não atrasa UI/áudio |
| Core 1 | UI (`loop`/LVGL), SPI do display e touch, decodificação + saída I2S | latência previsível para tela e áudio |
Regras práticas:
1. Comunicar entre núcleos por queues/ring buffers (stream buffer para áudio), nunca variáveis soltas; `volatile` não basta para dados compostos.
2. Áudio precisa de buffer DMA grande (>= 4-8 buffers) e task com prioridade maior que a UI; UI nunca bloqueia o loop de áudio.
3. Toda task em loop deve bloquear (delay, queue, notificação) para não matar a IDLE e disparar o TWDT.
4. Stack por task: começar com 4-8 KB (decoder MP3/AAC: 16 KB+), medir com `uxTaskGetStackHighWaterMark`.
5. Buffers grandes (áudio, framebuffer, rede) na PSRAM (8 MB) com `heap_caps_malloc(MALLOC_CAP_SPIRAM)`; DMA exige memória interna.
6. Medir antes de otimizar: `vTaskGetRunTimeStats` / contar ciclos por núcleo; só mover tarefa se houver ganho real.
7. Não compartilhar o I2C (touch 0x38 + codec 0x18, mesmo barramento) entre núcleos sem mutex.
8. Se um dia houver áudio: manter a task de áudio no Core 1 junto da UI e a rede no Core 0.
