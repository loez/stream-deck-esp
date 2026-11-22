# LVGL na ES3C28P: o que medimos (2026-11-20, demo-lvgl, LVGL 9.6, ESP32-S3 240 MHz)

## Driver de tela
- TFT_eSPI + DMA NÃO funciona no S3 com Arduino core 3.x (tela preta após o 1º bloco). Sem DMA funciona mas é lento.
- Solução: `esp_lcd` direto (spi_bus_initialize SPI3 + `esp_lcd_new_panel_io_spi` + init ILI9341 manual + `esp_lcd_panel_io_tx_color`).
  `on_color_trans_done` chama `lv_display_flush_ready` (ISR): DMA assíncrono de verdade, 2 buffers de 320x60 na RAM interna.
- SPI a 80 MHz NÃO serve: não acelera (o gargalo é a CPU) e deixa a imagem com áreas cortadas/corrompidas que só se corrigem ao redesenhar (confirmado na prática). 40 MHz = limite seguro, imagem limpa (confirmado).
- Modo de flash QIO (vs DIO) não mudou o tempo de render. Mantido `dio_opi`.

## Medição honesta da carga do núcleo
- Sem `lv_display_set_flush_wait_cb`, o LVGL espera o DMA em laço ocupado: o Core 1 aparece a ~99% sem fazer trabalho.
  Com wait_cb dormindo num semáforo (dado pela ISR), o mesmo Painel caiu para ~26% e depois ~16%.
- O FPS reportado = atualizações reais por segundo, não o teto. Teto = 1 / (tempo de render+envio por quadro).

## O que pesa (e como evitar)
- Custo ≈ nº de operações de desenho + áreas invalidadas, não só pixels (~1,2 a 1,7 µs/px nos testes).
- `lv_label_set_text`/`lv_arc_set_value` redesenham mesmo com valor igual: só atualizar quando mudou (helpers setFmt/setArc/setBar).
  Painel: 22,5 -> 7,5 ms por quadro e 13k -> 3,6k px por quadro.
- Mover muitos objetos com `lv_obj_set_x` custa muito (layout + 1 invalidação por objeto; acima de ~32 áreas invalidadas
  o LVGL cai para tela cheia). Melhor: um objeto com `LV_EVENT_DRAW_MAIN_END` e `lv_draw_rect` para cada bolinha + 1 timer de invalidação.
  Resultado: 40 objetos = 49 fps, 80 objetos = 35 fps (Core 1 a ~95%, render-bound).
- Widget `colorwheel` não existe no LVGL 9: usar canvas RGB565 na PSRAM.
- Menu: `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=4096` no Arduino: malloc >= 4 KB vai para a PSRAM (lenta para DMA/render).
  Buffers de DMA: `heap_caps_malloc(MALLOC_CAP_DMA|MALLOC_CAP_INTERNAL)`.

## Ferramenta de benchmark
`demo-lvgl` imprime `[perf]` a cada 5 s no serial e aceita comandos: `1`-`4` troca de aba, `a`/`b`/`z` = 40/80/0 objetos,
`k` liga/desliga 3 notas, `x/y/m/t/r` escondem grupos de widgets (experimentos). Útil para medir sem tocar na tela.
