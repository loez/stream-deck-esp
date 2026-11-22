# Adapting Stream Deck ESP to your ESP32 touch-screen board

*[Português](../ADAPTAR-PLACA.md)*

This guide is for people who have **another board** (or want to use another screen) and want to run Stream Deck ESP on it. You can follow it yourself or hand it to an AI assistant together with your board's data.
For the test battery to run on a new board, also see [NEW-BOARD-TESTS.md](NEW-BOARD-TESTS.md).

## 1. Will your board work?

The firmware (`src/main.cpp`) is the same for every board. What changes from one board to another is **one file**: `src/board_<name>.cpp` (pins, screen, touch, backlight). The server, the app, the plugins and the button configuration **do not change**: the board reports its screen size and the server computes the grid by itself.

| Requirement | Needed | Notes |
|---|---|---|
| Chip | **ESP32-S3** (recommended) | ESP32-S2 only with a lot of effort; **ESP32-P4** (MIPI-DSI screen) is much more work; classic ESP32 and C3 **do not work** (no PSRAM / too little RAM) |
| PSRAM | **Yes, 8 MB ideal** (minimum 2 MB) | Button images, LVGL and TLS live there. It does not fit without PSRAM |
| Flash | 4 MB works; 8 or 16 MB is better | See "Partitions" in step 3 |
| Screen | Any the ESP32 can drive | SPI (ILI9341, ST7789, ST7796, ILI9488…) is the easy case; parallel RGB is possible; MIPI-DSI is hard |
| Touch | **Required** (capacitive or resistive) | FT6336/FT5x06, GT911, CST816, CST328, XPT2046… |
| Wi-Fi | The ESP32's own | The board finds the server on the network by itself (mDNS) |
| Physical size | Buttons of at least 12 x 7.5 mm | Very small screens (< 2") end up with few buttons |
| USB cable | The S3's native USB ("USB" / "JTAG" port) | The cable connection (tunnel over serial) only exists with native USB; without it only Wi-Fi works |

If your board meets this, the work is to write the board file and get three things right: **image, touch and memory**.

## 2. What to gather before you start
1. **Exact model** and the manufacturer's page (schematic/pin table and, ideally, the **official Arduino/ESP-IDF/LVGL example**: it contains the screen's init sequence and the right pins).
2. **Chip, flash and PSRAM** (e.g. ESP32-S3, 16 MB, 8 MB octal). It is printed on the chip or on the board's spec sheet.
3. **Screen:** inches, resolution, controller and interface (SPI / RGB / DSI), native orientation, whether it needs **color inversion**.
4. **Touch:** controller, I²C address or SPI pins, reset and interrupt pins.
5. **Backlight:** pin and whether it is PWM or fixed. **Extras** that get in the way if left on: audio amplifier, LED, battery.
6. A **copy of the factory firmware** (step 4) before the first flash.

## 3. Step by step

### Step 1 — Set up the environment
You need Python 3 and PlatformIO. The project uses the Arduino core 3.x (pioarduino, already configured in `platformio.ini`).
```bash
python3 -m pip install --user platformio esptool      # or: pipx install platformio
pio run                                                # builds the default env (es3c28p) from the repository root
```
Confirm that the current board builds before touching anything. (`pio run -e my_board` builds a specific env.)

### Step 2 — Find the port and the chip
```bash
ls /dev/cu.usbmodem*                       # macOS; Linux: /dev/ttyACM0; Windows: COMx
esptool.py --port <port> chip_id
esptool.py --port <port> flash_id          # shows the flash size
```
The port number **changes when you replug the cable**. `No serial data received` is usually just a replug (or holding BOOT while plugging in).

### Step 3 — Create the environment in `platformio.ini`
Copy the `[env:es3c28p]` block and adjust. What depends on your board:

```ini
[env:my_board]
build_src_filter = +<*> -<board_*.cpp> +<board_my_board.cpp>
platform = https://github.com/pioarduino/platform-espressif32/releases/download/stable/platform-espressif32.zip
board = esp32-s3-devkitc-1
framework = arduino
board_build.flash_size = 16MB                 ; what flash_id showed
board_build.partitions = default_16MB.csv     ; 8 MB: default_8MB.csv · 4 MB: huge_app.csv (the app is ~2 MB)
board_build.arduino.memory_type = dio_opi     ; OCTAL PSRAM (most S3 N16R8). QUAD PSRAM (R2/R4): qio_qspi
board_upload.flash_size = 16MB
; ... keep lib_deps and build_flags the same as es3c28p's
```
The usual trouble spots:
- **Wrong `memory_type`** (octal vs quad) = the board reboots in a loop or cannot find the PSRAM. On "PSRAM ID read error", switch it.
- **Partitions:** the firmware is ~2 MB; `default.csv` (4 MB) has only a 1.25 MB app slot and **does not fit**: use `huge_app.csv`.
- `-DARDUINO_USB_CDC_ON_BOOT=1` assumes native USB; on boards with an external USB-serial bridge, remove it and use the regular serial.

### Step 4 — Back up the factory firmware
```bash
esptool.py --port <port> read_flash 0 0x1000000 backup_factory.bin   # 0x1000000 = 16 MB; adjust to your flash size
```
Keep it **outside the repository** (already in `.gitignore`: `backup/` and `*.bin`). **Never commit** a flash backup (it may contain Wi-Fi passwords). Without it you cannot go back to the original firmware.

### Step 5 — Write `src/board_<name>.cpp`
The interface is `include/board.h`. Six functions and one constant:

| Function | What it does |
|---|---|
| `const BoardInfo BOARD` | `{name, width, height, ppi, fill}` in **landscape** (see "Numbers" below) |
| `boardInit()` | Power pins, I²C, touch reset, backlight **off**. Turn off what you don't use (e.g. the audio amplifier) |
| `boardDisplayInit(disp)` | Bus + panel + **LVGL buffers** + send callback (`flush`) |
| `boardFlushIdle()` | `true` when the last send to the screen has finished |
| `boardTouch(&x,&y)` | `true` if there is a touch; x,y already in screen orientation (0..w-1, 0..h-1) |
| `boardBacklight(0..255)` | Brightness |
| `boardPowerOff()` | Turn everything off before deep sleep |

**Minimal template** (SPI screen with a simple send and I²C touch; what is in `<...>` is specific to your board). The complete, asynchronous (DMA) version is in `src/board_es3c28p.cpp`; use it as reference:

```cpp
#include "board.h"
#include <Wire.h>
// <include your screen driver here: esp_lcd, LovyanGFX, TFT_eSPI, Arduino_GFX or the manufacturer's>

#define PIN_BL <pin>
#define PIN_I2C_SDA <pin>
#define PIN_I2C_SCL <pin>
#define PIN_TOUCH_RST <pin>
const BoardInfo BOARD = {"MyBoard", <width>, <height>, <ppi>, <fill>};

static void flush_cb(lv_display_t *disp, const lv_area_t *a, uint8_t *px) {
  const uint32_t w = a->x2 - a->x1 + 1, h = a->y2 - a->y1 + 1;
  // SPI usually wants the RGB565 bytes swapped:
  lv_draw_sw_rgb565_swap(px, w * h);
  // <send the pixels to the window (x1,y1)-(x2,y2) with the screen driver>
  lv_display_flush_ready(disp);   // if the send is synchronous, signal here; if it is DMA, signal from the "done" interrupt
}

void boardInit() {
  pinMode(PIN_BL, OUTPUT); analogWrite(PIN_BL, 0);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  pinMode(PIN_TOUCH_RST, OUTPUT); digitalWrite(PIN_TOUCH_RST, LOW); delay(10); digitalWrite(PIN_TOUCH_RST, HIGH); delay(100);
}
void boardDisplayInit(lv_display_t *disp) {
  // <initialize the bus and the panel (sequence from the manufacturer's example)>
  lv_display_set_flush_cb(disp, flush_cb);
  const size_t BUF = BOARD.w * 24 * 2;   // 24 lines of RGB565; double buffer
  void *b1 = heap_caps_malloc(BUF, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL), *b2 = heap_caps_malloc(BUF, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  lv_display_set_buffers(disp, b1, b2, BUF, LV_DISPLAY_RENDER_MODE_PARTIAL);
}
bool boardFlushIdle() { return true; }          // synchronous send: always free
void boardBacklight(int v) { analogWrite(PIN_BL, v); }
void boardPowerOff() { analogWrite(PIN_BL, 0); /* <panel to sleep> */ }
bool boardTouch(int *x, int *y) { /* <read the controller; convert to screen orientation; return false if there is no touch> */ return false; }
```
**Parallel RGB** panels (no SPI commands) use `esp_lcd_rgb_panel` with the frame in PSRAM (and an internal *bounce buffer*); there `flush` does not swap bytes and the mode is usually `LV_DISPLAY_RENDER_MODE_DIRECT`. This is the hardest case: ask for the official example.

**Numbers for `BOARD`:**
- `ppi = √(width² + height²) / diagonal in inches`. E.g. 320x240 at 2.8" → 400 / 2.8 ≈ **143**. It defines the minimum physical size of the buttons.
- `fill` = pixels per second the screen can redraw (it limits GIFs). SPI at 40 MHz ≈ 1.7 Mpx/s in total; use ~1,000,000. Parallel RGB is much higher (about 10x). If unsure, start with 1000000.

### Step 6 — First boot: image
Flash (see "Flashing safely") and open the serial monitor (`pio device monitor`, 115200). Check:

| Symptom | Likely cause | Fix |
|---|---|---|
| White/black screen, nothing | Wrong init sequence, backlight, reset pin | Compare with the manufacturer's example; test the backlight at 255 |
| Swapped colors (red↔blue) | RGB/BGR order | BGR bit in the panel's MADCTL register (`0x36`) |
| "Negative" colors | Missing inversion | Command `0x21` (INVON): some panels need it (the ES3C28P does) |
| Mirrored or rotated image | Orientation | MADCTL `0x36` (MX/MY/MV bits) for landscape |
| Skewed/torn image | Clock too high (SPI) or RGB timing | Lower the clock (the ES3C28P corrupts at 80 MHz; it uses 40) |
| Odd colors only in text | Byte swap | Remove/add `lv_draw_sw_rgb565_swap` |
| Reboots in a loop | PSRAM `memory_type` | Step 3 |

The firmware's serial console accepts a `P` command that captures the screen so you can check it without a photo (see [NEW-BOARD-TESTS.md](NEW-BOARD-TESTS.md)).

### Step 7 — Touch
1. Read the controller raw and print x,y while touching the **four corners and the center**.
2. Convert to the screen orientation. Controllers often come swapped (x↔y) or inverted. The ES3C28P, for example, uses `x = raw_y` and `y = 240 − raw_x`, with a small measured scale (see the end of `board_es3c28p.cpp`).
3. Write the formulas in the board file itself. The touch must hit the edge buttons, with no "ghosts".
4. If the board has a touch **interrupt pin**, it is optional: polling is enough.

### Step 8 — Wi-Fi, pairing and server
Nothing changes: with the board on the same network as the computer, it finds the app (mDNS). Pair in the configuration page ("Parear placa"). For new Wi-Fi, the board opens its own portal (or send `W` over serial). The server shows "Board screen: WxH, ppi" and computes the grid limits.

### Step 9 — Memory
The bottleneck is **internal RAM** (Wi-Fi/TLS uses a lot). Care points:
- **Small** LVGL buffers in internal DMA memory (24 lines are enough); the big frame goes to PSRAM.
- Watch `[heap] interna … psram …` on serial after changing the grid several times: it must not drop on each change (leak).
- Larger screens use more image memory in PSRAM (project ceiling: 6 MB). Read [hardware/MEMORY-RAM.md](hardware/MEMORY-RAM.md) and [hardware/MULTICORE.md](hardware/MULTICORE.md) (Core 0 = network, Core 1 = screen/touch).

### Step 10 — Fine tuning on the server (optional)
In `node/src/settings.ts`: `MIN_BTN_MM` (minimum button size for a finger to hit) and `limitsFor` (font range and columns/rows per density). If your screen is used with "thick" fingers, raise the minimum.

### Step 11 — Flashing safely
- Flash only after the backup (step 4).
- If the app is running with the cable connection, release the port first: `curl -XPOST localhost:8765/api/usb -d '{"enabled":false}'`, flash, and turn it back on with `true`.
- `pio run -t upload --upload-port <port>` (or `esptool.py write_flash`).
- If the board does not respond, **replug the cable** (it is not dead).
- **Going back to stock:** `esptool.py --port <port> write_flash 0 backup_factory.bin`.

### Step 12 — Validate
- Run `cd node && npm test` (includes the grid tests with a fake screen).
- Do the battery in [NEW-BOARD-TESTS.md](NEW-BOARD-TESTS.md): image, touch, grid (2x2 up to the maximum), page switching, GIF, memory, Wi-Fi for hours.
- Confirm the **ES3C28P still works** (build its env).
- Document your board: pins, calibration and panel quirks in `docs/hardware/<BOARD>.md` (see `docs/hardware/ES3C28P.md` as an example) and open a pull request.

## 4. Ask for help (what to send)
Paste this filled in, in an issue or to an AI assistant, and ask for the `board_<name>.cpp` and the `[env:…]`:
```
Board: <model + link>
Chip/flash/PSRAM: <e.g. ESP32-S3, 16 MB, 8 MB octal>
Screen: <inches, resolution, controller, SPI/RGB/DSI interface, pins>
Touch: <controller, I2C (SDA/SCL/address) or SPI, reset/INT pins>
Backlight: <pin, PWM?>   Extras to keep off: <amplifier, LED...>
Manufacturer's official example: <link or file>
```
Whoever helps needs the board **plugged into the computer** to flash and see the results (and will ask you to replug the cable and tell what you see on screen).

## 5. Known limits
- **No touch:** not supported today (the interface is the touch screen).
- **Portrait orientation** and **several boards at the same time:** not yet.
- **MIPI-DSI (ESP32-P4):** needs another driver and probably another core version; treated as a separate project.
- Monochrome screens (e-paper, 1-bit OLED) are not suitable: the server sends color images.
