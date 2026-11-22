# Placa ES3C28P (LCDWiki / Fikra "Preta"): análise de hardware

*[English](../en/hardware/ES3C28P.md)*

## Fatos medidos (via esptool, somente leitura)
- Chip: ESP32-S3 (QFN56), revisão v0.2, WiFi + BLE, cristal 40 MHz
- PSRAM embutida: 8 MB (eFuse: AP_3v3, 85C)
- Flash: 16 MB, quad (4 linhas), 3,3 V, fabricante 0x5e, device 0x4018, modo DIO
- USB: USB-Serial/JTAG nativo (VID 0x303A, PID 0x1001), porta no macOS `/dev/cu.usbmodemXXXX` (o número muda ao replugar)
- eFuses: sem secure boot, sem flash encryption, JTAG não desabilitado
- Boot ROM: ESP-ROM:esp32s3-20210327, SPI_FAST_FLASH_BOOT

## Tabela de partições (layout default_16MB)
| nome | tipo | offset | tamanho |
|---|---|---|---|
| nvs | data/nvs | 0x009000 | 20 KB |
| otadata | data/ota | 0x00e000 | 8 KB |
| app0 | app/ota_0 | 0x010000 | 6400 KB |
| app1 | app/ota_1 | 0x650000 | 6400 KB (vazia, 0xFF) |
| spiffs | data/littlefs | 0xc90000 | 3456 KB |
| coredump | data/coredump | 0xff0000 | 64 KB |

## Firmware de fábrica
A unidade analisada vinha com um firmware de Arduino-ESP32 (IDF v5.5.5) cliente de tela remota e com resquícios de um firmware de web rádio no LittleFS (partição `spiffs`); a definição de placa gravada era "ESP32-S3-DevKitC-1-N8 (8 MB QD, No PSRAM)", mas **a placa real tem 16 MB de flash e 8 MB de PSRAM**: ajuste a configuração de placa nos projetos novos. O conteúdo de fábrica varia por lote; faça o backup antes de gravar (seção abaixo).

## Placa identificada: LCDWiki ES3C28P (vendida pela Fikra como "ESP32 S3 Display 2.8 touch – Preta")
Fonte: manual técnico LCDWiki V1.0 (2025-06-14) + exemplos da Fikra.
Página: https://fikra.com.br/esp32/preta/ (manual, firmware de teste, projeto de caixa de som MP3/SD, STLs de case).
Coerente com o chip medido (16 MB flash, 8 MB PSRAM). O manual diz PSRAM OPI; o esptool mostrou "AP_3v3".

### Pinagem (confirmada por manual + código de exemplo)
| Função | Pinos |
|---|---|
| Display ILI9341V 240x320 SPI (HSPI), 40 MHz | SCK 12, MOSI 11, MISO 13, CS 10, DC 46, RST ligado ao CHIP_PU (-1), BL 45 (HIGH liga, PWM ok) |
| Touch capacitivo FT6336G (I2C 0x38) | SDA 16, SCL 15, INT 17, RST 18 (I2C compartilhado com codec e conector I2C) |
| Codec de áudio ES8311 (I2C 0x18) | mesmo I2C 16/15 |
| I2S | MCLK 4, BCLK 5, LRCK/WS 7, DOUT 8 (ESP→ES8311 DSDIN, speaker), DIN 6 (ES8311 DSDOUT, microfone) |
| Amplificador 8002E (1,5 W 8Ω / 2 W 4Ω) | GPIO1 /SHUTDOWN: LOW = ligado |
| Microfone MEMS (via ES8311) | I2S DIN 6 |
| MicroSD SDMMC 4 bits | CLK 38, CMD 40, D0 39, D1 41, D2 48, D3 47 |
| LED RGB endereçável (WS2812-like) | GPIO42 |
| Bateria (**LiHV** Veken YW-009 1ICP4/57/86: 3,8 V nominal, carga máx. 4,35 V, 3020 mAh / 11,47 Wh, com proteção; conector 1.25 mm 2P; carga ~290 mA) | leitura de tensão no ADC GPIO9; divisor ≈ 2:1 (leitura bruta 2090 mV = 4,18 V com K=2,0 e USB conectado; ver abaixo) |
| Botão BOOT | GPIO0 |
| UART0 | TX 43, RX 44 (conector 4P) |
| USB nativo | D- 19, D+ 20 |
| Expansão livre | GPIO2, 3, 14, 21 (conector 4P) |
| PSRAM OPI / Flash | GPIO26–37 (reservados, não usar) |

Atenção: o manual rotula GPIO6/GPIO8 de forma ambígua; o código de exemplo que funciona usa DOUT=8 e DIN=6.
Reset (CHIP_PU) reinicia o ESP e o LCD juntos.

### Resultados de testes reais (2026-11-20)
- Status geral : FUNCIONAM tela (cores certas após inversão), touch (inclui mapeamento paisagem x=y_raw, y=240-x_raw), som (speaker + mic), LED RGB, bateria (leitura aparece), Wi-Fi e sistema.
- microSD: NÃO testado (placa sem cartão). Código de montagem 4 bits existe; testar quando houver cartão.
- Bateria (2026-11-21, sem multímetro): leitura bruta 2090 mV estável com USB ligado => 4,18 V com K=2,0; o carregador da placa parece terminar em ~4,20 V (a bateria é LiHV de 4,35 V, então a placa a carrega a ~85%). Ambiguidade não resolvida sem multímetro: K=2,0 com carregador de 4,20 V (mais provável) ou K≈2,08 com carregador de 4,35 V. o firmware usa BAT_K=2,0 e curva LiPo 3,30 V=0% .. 4,20 V=100%; `usb_serial_jtag_is_connected()` detecta USB de dados (carregador de parede não é detectado).
- Tela: precisa de inversão de cor (TFT_eSPI `-DTFT_INVERSION_ON=1`, ou `tft.invertDisplay(true)`); sem ela R/G/B/branco saem ciano/magenta/amarelo/preto. Ordem RGB correta.

### Configuração Arduino recomendada
Board ESP32S3 Dev Module, USB Mode "Hardware CDC and JTAG", Flash 16 MB, PSRAM OPI (8 MB),
partições conforme necessidade (a Fikra usa Huge APP 3MB; o firmware atual usa o layout 16MB com OTA).
Taxa de áudio fixa 44100 Hz (MCLK = 44100*256).

### Material do fabricante (não incluído aqui)
manual técnico, firmware de teste e exemplos de som (ES8311, microSD) estão na página do fabricante (Fikra).
Não baixado (356 MB): https://fikra.com.br/esp32/preta/?download=Pack_Documenta%C3%A7%C3%A3o_Completo.rar
Página oferece "firmware original" de fábrica via Web Serial (instala por cima da flash).

## Backup do firmware de fábrica
Antes da primeira gravação, faça a cópia da flash inteira (`esptool.py --port <porta> read_flash 0 0x1000000 backup_fabrica.bin`) e guarde **fora do repositório**: ela contém a NVS, ou seja, a senha do Wi-Fi em claro. Para restaurar: `esptool.py --port <porta> write_flash 0 backup_fabrica.bin`. Se a porta não responder, segure BOOT e dê reset para entrar em modo download.

## Calibração do touch FT6336G (medida em 2026-11-20)
Passando o dedo nas 4 bordas: **ry 10..309** (eixo X da tela paisagem, 320 px) e **rx 0..237** (eixo Y, 240 px). Há zona morta de ~10 px em cada lateral.
Mapeamento que deixa as bordas certas: `x = (ry-10)*319/299`, `y = 239 - rx*239/237` (ambos com constrain). Conferido na prática: as bordas ficam certas.
Botões também ganham `lv_obj_set_ext_click_area(b, 8)`.

## Desligar a placa (deep sleep) — validado em 2026-11-21
`boardPowerOff()` (GPIO45 em LOW + `gpio_hold_en` + `gpio_deep_sleep_hold_en`, ILI9341 `0x28`/`0x10`) seguido de `esp_deep_sleep_start()` sem fonte de despertar: o backlight **fica apagado** durante o sleep e só o botão RESET (EN) religa, voltando normal. O servidor manda `pwr` uma única vez em `/api/deck` (senão desligaria de novo ao religar).
