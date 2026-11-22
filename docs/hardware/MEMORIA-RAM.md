# RAM interna é o recurso escasso (medido no radio-web, 2026-11-20)

ESP32-S3 com PSRAM de 8 MB, mas a RAM **interna** (~330 KB úteis) acaba rápido com Wi-Fi + LVGL + áudio + TLS.

## Orçamento medido (interna livre)
| Etapa | Livre |
|---|---|
| início do app | 277 KB |
| após LVGL + display (2 buffers DMA) | ~200 KB |
| UI pronta (3 telas, fontes TTF) | ~164 KB |
| após Wi-Fi conectado | ~90 KB (o Wi-Fi sozinho custa ~90 KB) |
| tocando stream HTTPS (com TLS na PSRAM) | ~70 KB (estável, sem vazamento em 14 trocas) |

Sem as medidas abaixo, a 1ª versão caiu para 6 KB livres e abortou (`ESP_ERR_NO_MEM` em `phy_track_pll_init`), e uma única sessão TLS levava a RAM a 11 KB.

## Medidas que funcionaram
1. `heap_caps_malloc_extmem_enable(512)` no início do `setup()`: malloc >= 512 B vai para a PSRAM (o padrão do framework é 4096).
2. TLS na PSRAM: `-Wl,--wrap=esp_mbedtls_mem_calloc` + `__wrap_esp_mbedtls_mem_calloc` com `heap_caps_calloc(MALLOC_CAP_SPIRAM)`
   (o framework compila mbedtls com `MBEDTLS_INTERNAL_MEM_ALLOC`; cada sessão HTTPS usa ~50 KB interna).
3. Pilhas das tarefas de áudio e de rede na PSRAM: `xTaskCreatePinnedToCoreWithCaps(..., MALLOC_CAP_SPIRAM)` (`freertos/idf_additions.h`).
   NÃO colocar na PSRAM tarefas que gravam na flash/NVS (ex.: a que chama `WiFi.begin(ssid, senha)`).
4. Buffers de render do LVGL pequenos (2 x 320x24 em RAM interna/DMA) e fontes TTF com cache de glifos pequeno (`LV_TINY_TTF_CACHE_GLYPH_CNT 48`).
5. Chamadas à API do Radio Browser por **HTTP** (aceita em de1/all) em vez de HTTPS; HTTPS só como último recurso se houver >= 30 KB de bloco livre.
6. Listas grandes (resultados, favoritas) com `heap_caps_calloc(MALLOC_CAP_SPIRAM)`; ArduinoJson com filtro.

## Descobertas da 2ª rodada (crash "volta para a tela inicial" ao buscar)
Sintoma: o app reiniciava no meio da busca. Causa: `ESP_ERR_NO_MEM` em `esp_timer_create` chamado por `phy_track_pll_init`
(cadeia: ppTask -> pm_wake_up -> esp_phy_enable). Era **pico transitório** de RAM interna: a lista de 40 estações custava ~47 KB
(centenas de objetos LVGL pequenos) e somava com o pico de buffers do Wi-Fi ao baixar o JSON -> chegava a 3 KB livres.
Correções, em ordem de impacto:
1. **Heap inteiro do LVGL na PSRAM** (`LV_USE_STDLIB_MALLOC LV_STDLIB_CUSTOM` + `src/lv_mem_psram.cpp` com `heap_caps_malloc(MALLOC_CAP_SPIRAM)`).
   Interna livre passou de 48-95 KB (oscilando) para **156-159 KB estável**, 0 reinícios em 22 passos de estresse (`tools/stress.py`).
2. ArduinoJson com alocador próprio na PSRAM (`JsonDocument doc(&psramAlloc)`): o JSON gerava milhares de alocações pequenas internas.
3. `esp_wifi_set_ps(WIFI_PS_NONE)` ao conectar (só `WiFi.setSleep(false)` antes do begin não bastou: o log ainda mostrava pm_wake_up).
4. Menos dados por busca (`limit=45`).

ARMADILHA: `heap_caps_malloc_extmem_enable(128)` quebrou o **recebimento de comandos pelo serial USB** (nenhum comando respondia).
Com 512 funciona. Não usar limiar < 512 sem testar o serial.

## Como medir
`heapLog(tag)` imprime interna livre, maior bloco contíguo e PSRAM. O maior bloco importa tanto quanto o total (fragmentação).

## Engasgo de áudio: a interface disputa recursos com o decodificador (Rádio Bandeirantes Goiânia, HE-AAC)
Métrica que funciona: **blocos de PCM por segundo** no gancho `audio_process_i2s` (tempo real a 44,1 kHz = 172/s; a 48 kHz = 187/s).
- Antes: tela ligada = 92-124 blocos/s (72% do tempo real), 80 falhas/6 s, Core 0 e Core 1 a ~99%. Tela desligada = 172/s e Core 0 a 67%.
  Conclusão: a UI (heap do LVGL na PSRAM + render + DMA SPI) tira o decodificador do ritmo; o engasgo era déficit de vazão, não rede (buffer de entrada enchia).
- O texto do nome rolando (marquee) mantinha a UI a 40 quadros/s (60% do Core 1) mesmo com a rádio parada.
- Correções: (1) sem marquee (nome com "...", título em até 2 linhas); (2) visualizador a 15 fps; (3) alocador do LVGL híbrido
  (`lv_mem_psram.cpp`: blocos <= 384 B na RAM interna enquanto houver > 110 KB livres, o resto na PSRAM).
- Depois: 172 blocos/s com a tela ligada em Bandeirantes (AAC https), Antena 1 (AAC http), CBN Vale (AAC https) e Mix FM (MP3 https).
- Buffers de áudio da lib: DMA 16 x 256 frames (~93 ms) + fila de PCM decodificado ~370 ms; intervalos de 40-70 ms entre chamadas do gancho NÃO são falha audível.
- `audio.setAudioTaskCore()` com rádio tocando derruba o áudio (usar só antes de tocar).

## Engasgo ao ROLAR a lista (rádio HE-AAC tocando): era prioridade de tarefa no Core 0
Sintoma: rolando a lista da Biblioteca o áudio caía para 73-130 blocos/s (de 172), mesmo com a interface leve.
Hipóteses descartadas por medição: taxa de quadros da UI (10-60 ms de refresh, sem efeito), envio SPI ao painel (`N1` descarta o envio, continuou caindo),
modo QIO do flash (sem efeito; o pioarduino grava header DIO e o resultado não mudou), local dos objetos LVGL (reserva interna 64 vs 110 KB), fila de PCM maior (DMA 448x9, sem efeito),
imagens da lista (esconder as imagens e rolar só fundos lisos ainda derrubava o áudio).
**Causa real:** a minha `audioTask` (que chama `audio.loop()`: leitura da rede/TLS) tinha prioridade 3 e acordava a cada 1 ms, MAIOR que a `PeriodicTask` da biblioteca (decodificação+I2S, prio 2), e tirava CPU do decodificador no Core 0 sempre que a interface apertava o sistema.
**Correção:** `audioTask` com prioridade 1 e `vTaskDelay(pdMS_TO_TICKS(4))` (o buffer de entrada de ~640 KB dispensa bombear a rede a cada ms).
Resultado: 172-174 blocos/s rolando a lista (Buscar e Favoritas) com 4 rádios (AAC+ https, AAC http/https, MP3), e no player 0 falhas de intervalo (antes ~35 por janela).
Lição: em tarefas que dividem um núcleo com um decodificador de áudio, a de rede/IO deve ter prioridade MENOR que a do decodificador e não acordar a cada tick.
Extra mantido: linhas da lista pré-renderizadas em imagem (snapshot RGB565, custo de render ~2,5x menor) e `lv_indev_set_scroll_throw(in, 35)`.
