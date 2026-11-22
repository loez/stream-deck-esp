# RAM interna é o recurso escasso (medições na ES3C28P)

*[English](../en/hardware/MEMORY-RAM.md)*

ESP32-S3 com PSRAM de 8 MB, mas a RAM **interna** (~330 KB úteis) acaba rápido com Wi-Fi + LVGL + TLS (+ áudio, se um dia houver).

## Orçamento típico (interna livre)
Medido num app de demonstração com Wi-Fi, LVGL e TLS na mesma placa:

| Etapa | Livre |
|---|---|
| início do app | 277 KB |
| após LVGL + display (2 buffers DMA) | ~200 KB |
| UI pronta (3 telas, fontes TTF) | ~164 KB |
| após Wi-Fi conectado | ~90 KB (o Wi-Fi sozinho custa ~90 KB) |
| sessão HTTPS (com TLS na PSRAM) | ~70 KB (estável, sem vazamento) |

Sem as medidas abaixo, a 1ª versão caiu para 6 KB livres e abortou (`ESP_ERR_NO_MEM` em `phy_track_pll_init`), e uma única sessão TLS levava a RAM a 11 KB.
No Stream Deck, o modo autônomo mede ~115 KB livres antes de entrar e ~64 KB nele (ver `MODO-AUTONOMO.md`).

## Medidas que funcionaram
1. `heap_caps_malloc_extmem_enable(512)` no início do `setup()`: malloc >= 512 B vai para a PSRAM (o padrão do framework é 4096).
2. TLS na PSRAM: `-Wl,--wrap=esp_mbedtls_mem_calloc` + `__wrap_esp_mbedtls_mem_calloc` com `heap_caps_calloc(MALLOC_CAP_SPIRAM)`
   (o framework compila mbedtls com `MBEDTLS_INTERNAL_MEM_ALLOC`; cada sessão HTTPS usa ~50 KB internos).
3. Pilhas de tarefas grandes na PSRAM: `xTaskCreatePinnedToCoreWithCaps(..., MALLOC_CAP_SPIRAM)` (`freertos/idf_additions.h`).
   NÃO colocar na PSRAM tarefas que gravam na flash/NVS (ex.: a que chama `WiFi.begin(ssid, senha)`).
4. Buffers de render do LVGL pequenos (2 x 320x24 em RAM interna/DMA) e fontes TTF com cache de glifos pequeno (`LV_TINY_TTF_CACHE_GLYPH_CNT`).
5. Listas grandes com `heap_caps_calloc(MALLOC_CAP_SPIRAM)`; ArduinoJson com filtro.

## O crash "volta para a tela inicial"
Sintoma: o app reiniciava no meio de uma operação de rede. Causa: `ESP_ERR_NO_MEM` em `esp_timer_create` chamado por `phy_track_pll_init`
(cadeia: ppTask -> pm_wake_up -> esp_phy_enable). Era **pico transitório** de RAM interna: uma lista de 40 itens custava ~47 KB
(centenas de objetos LVGL pequenos) e somava com o pico de buffers do Wi-Fi ao baixar um JSON -> chegava a 3 KB livres.
Correções, em ordem de impacto:
1. **Heap inteiro do LVGL na PSRAM** (`LV_USE_STDLIB_MALLOC LV_STDLIB_CUSTOM` + `src/lv_mem_psram.cpp` com `heap_caps_malloc(MALLOC_CAP_SPIRAM)`).
   Interna livre passou de 48-95 KB (oscilando) para **156-159 KB estável**, 0 reinícios em 22 passos de estresse.
2. ArduinoJson com alocador próprio na PSRAM (`JsonDocument doc(&psramAlloc)`): o JSON gerava milhares de alocações pequenas internas.
3. `esp_wifi_set_ps(WIFI_PS_NONE)` ao conectar (só `WiFi.setSleep(false)` antes do begin não bastou: o log ainda mostrava pm_wake_up).
4. Menos dados por requisição.

ARMADILHA: `heap_caps_malloc_extmem_enable(128)` quebrou o **recebimento de comandos pelo serial USB** (nenhum comando respondia).
Com 512 funciona. Não usar limiar < 512 sem testar o serial.

## Como medir
`heapLog(tag)` imprime interna livre, maior bloco contíguo e PSRAM. O maior bloco importa tanto quanto o total (fragmentação).

## Se você adicionar áudio (lições de um projeto anterior na mesma placa)
- A interface disputa CPU e barramento com o decodificador. A métrica que funcionou: **blocos de PCM por segundo** no gancho de saída I2S (tempo real a 44,1 kHz = 172/s).
- Evite texto rolando (marquee) e animações que mantenham a UI a dezenas de quadros por segundo com o áudio tocando.
- Alocador do LVGL híbrido (`lv_mem_psram.cpp`: blocos pequenos na RAM interna enquanto houver folga, o resto na PSRAM) ajuda a vazão.
- A tarefa de rede/E-S que divide o núcleo com o decodificador deve ter prioridade **menor** que a do decodificador e não acordar a cada tick (`vTaskDelay` de alguns ms).
