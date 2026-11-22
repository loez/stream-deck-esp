# ES3C28P board (LCDWiki / Fikra "Preta"): hardware analysis

*[Português](../../hardware/ES3C28P.md)*

## Measured facts (via esptool, read-only)
- Chip: ESP32-S3 (QFN56), revision v0.2, WiFi + BLE, 40 MHz crystal
- Embedded PSRAM: 8 MB (eFuse: AP_3v3, 85C)
- Flash: 16 MB, quad (4 lines), 3.3 V, manufacturer 0x5e, device 0x4018, DIO mode
- USB: native USB-Serial/JTAG (VID 0x303A, PID 0x1001), port on macOS `/dev/cu.usbmodemXXXX` (the number changes when you replug)
- eFuses: no secure boot, no flash encryption, JTAG not disabled
- Boot ROM: ESP-ROM:esp32s3-20210327, SPI_FAST_FLASH_BOOT

## Partition table (default_16MB layout)
| name | type | offset | size |
|---|---|---|---|
| nvs | data/nvs | 0x009000 | 20 KB |
| otadata | data/ota | 0x00e000 | 8 KB |
| app0 | app/ota_0 | 0x010000 | 6400 KB |
| app1 | app/ota_1 | 0x650000 | 6400 KB (empty, 0xFF) |
| spiffs | data/littlefs | 0xc90000 | 3456 KB |
| coredump | data/coredump | 0xff0000 | 64 KB |

## Factory firmware
The unit analyzed shipped with an Arduino-ESP32 (IDF v5.5.5) remote-screen-client firmware and leftovers of a web-radio firmware in LittleFS (the `spiffs` partition); the board definition flashed was "ESP32-S3-DevKitC-1-N8 (8 MB QD, No PSRAM)", but **the real board has 16 MB of flash and 8 MB of PSRAM**: adjust the board configuration in new projects. Factory contents vary by batch; back it up before flashing (section below).

## Identified board: LCDWiki ES3C28P (sold by Fikra as "ESP32 S3 Display 2.8 touch – Preta")
Source: LCDWiki technical manual V1.0 (2025-06-14) + Fikra examples.
Page: https://fikra.com.br/esp32/preta/ (manual, test firmware, MP3/SD speaker project, case STLs).
Consistent with the measured chip (16 MB flash, 8 MB PSRAM). The manual says OPI PSRAM; esptool showed "AP_3v3".

### Pinout (confirmed by manual + example code)
| Function | Pins |
|---|---|
| ILI9341V 240x320 SPI display (HSPI), 40 MHz | SCK 12, MOSI 11, MISO 13, CS 10, DC 46, RST tied to CHIP_PU (-1), BL 45 (HIGH = on, PWM ok) |
| FT6336G capacitive touch (I2C 0x38) | SDA 16, SCL 15, INT 17, RST 18 (I2C shared with the codec and the I2C connector) |
| ES8311 audio codec (I2C 0x18) | same I2C 16/15 |
| I2S | MCLK 4, BCLK 5, LRCK/WS 7, DOUT 8 (ESP→ES8311 DSDIN, speaker), DIN 6 (ES8311 DSDOUT, microphone) |
| 8002E amplifier (1.5 W 8Ω / 2 W 4Ω) | GPIO1 /SHUTDOWN: LOW = on |
| MEMS microphone (via ES8311) | I2S DIN 6 |
| MicroSD SDMMC 4-bit | CLK 38, CMD 40, D0 39, D1 41, D2 48, D3 47 |
| Addressable RGB LED (WS2812-like) | GPIO42 |
| Battery (**LiHV** Veken YW-009 1ICP4/57/86: 3.8 V nominal, 4.35 V max charge, 3020 mAh / 11.47 Wh, protected; 1.25 mm 2P connector; ~290 mA charge) | voltage read on ADC GPIO9; divider ≈ 2:1 (raw reading 2090 mV = 4.18 V with K=2.0 and USB connected; see below) |
| BOOT button | GPIO0 |
| UART0 | TX 43, RX 44 (4P connector) |
| Native USB | D- 19, D+ 20 |
| Free expansion | GPIO2, 3, 14, 21 (4P connector) |
| PSRAM OPI / Flash | GPIO26–37 (reserved, do not use) |

Note: the manual labels GPIO6/GPIO8 ambiguously; the example code that works uses DOUT=8 and DIN=6.
Reset (CHIP_PU) restarts the ESP and the LCD together.

### Real test results (2026-11-20)
- Overall: screen (right colors after inversion), touch (including the landscape mapping x=raw_y, y=240-raw_x), sound (speaker + mic), RGB LED, battery (a reading shows up), Wi-Fi and system all WORK.
- microSD: NOT tested (board without a card). 4-bit mount code exists; test when a card is available.
- Battery (2026-11-21, no multimeter): steady raw reading 2090 mV with USB plugged => 4.18 V with K=2.0; the board's charger seems to stop at ~4.20 V (the battery is 4.35 V LiHV, so the board charges it to ~85%). Ambiguity unresolved without a multimeter: K=2.0 with a 4.20 V charger (more likely) or K≈2.08 with a 4.35 V charger. The firmware uses BAT_K=2.0 and a LiPo curve 3.30 V=0% .. 4.20 V=100%; `usb_serial_jtag_is_connected()` detects a data USB connection (a wall charger is not detected).
- Screen: needs color inversion (TFT_eSPI `-DTFT_INVERSION_ON=1`, or `tft.invertDisplay(true)`); without it R/G/B/white come out cyan/magenta/yellow/black. RGB order is correct.

### Recommended Arduino configuration
Board ESP32S3 Dev Module, USB Mode "Hardware CDC and JTAG", Flash 16 MB, PSRAM OPI (8 MB),
partitions as needed (Fikra uses Huge APP 3MB; the current firmware uses the 16MB layout with OTA).
Fixed audio rate 44100 Hz (MCLK = 44100*256).

### Manufacturer material (not included here)
The technical manual, test firmware and sound examples (ES8311, microSD) are on the manufacturer's (Fikra) page.
Not downloaded (356 MB): https://fikra.com.br/esp32/preta/?download=Pack_Documenta%C3%A7%C3%A3o_Completo.rar
The page offers the factory "original firmware" via Web Serial (installs over the flash).

## Factory firmware backup
Before the first flash, copy the whole flash (`esptool.py --port <port> read_flash 0 0x1000000 backup_factory.bin`) and keep it **outside the repository**: it contains the NVS, i.e. the Wi-Fi password in clear text. To restore: `esptool.py --port <port> write_flash 0 backup_factory.bin`. If the port does not respond, hold BOOT and reset to enter download mode.

## FT6336G touch calibration (measured on 2026-11-20)
Sliding a finger along the 4 edges: **ry 10..309** (X axis of the landscape screen, 320 px) and **rx 0..237** (Y axis, 240 px). There is a ~10 px dead zone on each side.
Mapping that gets the edges right: `x = (ry-10)*319/299`, `y = 239 - rx*239/237` (both with constrain). Checked in practice: the edges come out right.
Buttons also get `lv_obj_set_ext_click_area(b, 8)`.

## Powering the board off (deep sleep) — validated on 2026-11-21
`boardPowerOff()` (GPIO45 LOW + `gpio_hold_en` + `gpio_deep_sleep_hold_en`, ILI9341 `0x28`/`0x10`) followed by `esp_deep_sleep_start()` with no wake-up source: the backlight **stays off** during sleep and only the RESET (EN) button turns it back on, returning to normal. The server sends `pwr` only once in `/api/deck` (otherwise it would power off again on wake).
