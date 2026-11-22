# Test battery for a new board

*[Português](../NOVA-PLACA.md)*

> To adapt the project to **any other board** (requirements, step by step, code template and common problems), see [ADAPT-BOARD.md](ADAPT-BOARD.md). This document is the test battery to run once the new board exists.

**What is already done and tested on the ES3C28P:**
- The server receives the board's screen (`/api/deck?w=&h=&ppi=`) and computes grid, buttons and limits from the **physical size** (button >= 12 x 7.5 mm; format ceiling 8x6). 8-column virtual grid, migration of old configs.
- The firmware is portable: `include/board.h` (interface) + `src/board_es3c28p.cpp` (the current board). Dynamic image buffers in PSRAM (6 MB ceiling), safe handoff between the cores.
- Server tests with a fake 800x480 screen (`node/test/stride.ts`).

What only the hardware can answer: panel driver, touch, real performance and usability. This document is the script for that **test battery**.

## 1. What to gather (before writing `board_<name>.cpp`)
- Exact model / manufacturer's page link (and schematic or pin table, if any).
- Screen: size in inches, resolution, **interface type** (SPI, parallel RGB, MIPI-DSI), controller (ILI9488, ST7796, ST7262, NV3041...) and native orientation.
- Touch: controller (GT911, FT5x06, CST816...), bus (I2C: address and pins), reset/interrupt pin.
- Chip: ESP32-S3 (expected) or other (**ESP32-P4/MIPI-DSI is much more work**), flash, PSRAM (quad/octal, 8 MB?).
- Backlight (pin, PWM or wired on), LED, battery, microSD (only if it will be used).
- The manufacturer's official example (Arduino/ESP-IDF/LVGL): it usually has the panel init sequence and the pins.

## 2. Porting steps
1. Create `src/board_<name>.cpp` implementing `boardInit`, `boardDisplayInit`, `boardFlushIdle`, `boardTouch`, `boardBacklight` and `BOARD = {name, w, h, ppi}` (ppi = diagonal in pixels / diagonal in inches).
2. In `platformio.ini`: a new `[env:<name>]` (board, PSRAM `memory_type`, flash, `build_src_filter = +<*> -<board_*.cpp> +<board_<name>.cpp>`).
3. RGB/DSI panel: frame buffer in PSRAM (+ internal bounce buffer), `LV_DISPLAY_RENDER_MODE_DIRECT/PARTIAL` depending on the driver; check the clock rate (tearing/skewed screen = timing).
4. Calibrate touch (corners and center) and orientation; keep the calibration in `board_<name>.cpp`.
5. Check `lv_conf.h` (LVGL heap size in PSRAM, fonts) and task stacks.
6. Back up the new board's factory firmware before the first upload.

## 3. Test battery (tick as you go)
**Bring-up**
- [ ] Image appears right (colors, no inversion, no mirroring, landscape orientation); use `P` (capture) on serial.
- [ ] Touch hits: corners, center and button edges (use `T x,y` and real touch); no "ghost" touches or drift.
- [ ] Backlight: smooth PWM and timed turn-off.
- [ ] Wi-Fi + mDNS: the board finds the server without any setup.

**Geometry (the server decides from the reported screen)**
- [ ] The page shows the right "Board screen: WxH, ppi"; coherent limits (e.g. 4.3" 800x480 217 ppi: up to 7x6).
- [ ] For each grid (2x2, 4x2, 4x4, 6x4, maximum): buttons without overlap, equal margins, readable name strip, chosen font respected.
- [ ] Without the status strip: buttons move up and use the top.
- [ ] Changing the grid live does not freeze and leaves no old image (`[grade]` on serial; no `sem memoria`).
- [ ] Switching boards (ES3C28P <-> new) with the same configuration: grid adjusted to what fits, saved choice preserved.

**Physical usability (the most important point)**
- [ ] Finger accuracy at each button size; is the 12 x 7.5 mm limit right or does it need to go up/down? (adjust `MIN_BTN_MM` in `node/src/settings.ts`).
- [ ] Font legibility (10 to 24 px) at viewing distance; adjust the font range per density (`limitsFor`).
- [ ] Icons/images: sharpness and icon size (44/56 px) proportional to the button (`renderButton`); maybe scale by density.

**Performance (measure and note down)**
- [ ] Time to switch pages with N buttons (today 1 HTTP request per image). Goal: < 1.5 s with 35 buttons. If it fails: send images in batch (one `/api/imgs` with all of them), compress (PNG/JPEG decoded on the board) or send only what changed.
- [ ] Touch-to-effect latency (no perceptible lag).
- [ ] Memory: `[heap] interna/psram` after changing the grid several times; no leak (run the change-grid test 20x).
- [ ] Wi-Fi stable for hours (polls every 1.5 s; consider push instead of polling).
- [ ] Temperature/consumption if powered from the computer's USB.

**Animation and merged buttons**
- [x] ES3C28P: 4 GIFs together, a GIF on a 2x1 button and 20 page switches without a leak. Missing: GIF on 2x2/full screen and fine tuning of `BOARD.fill`/`ANIM_BUDGET` from measured fps; repeat on the bigger board.
- [ ] Larger screens: full-screen GIF at the maximum number of buttons (parallel RGB vs SPI fill).

**Regression**
- [ ] `cd node && npm test` (includes `stride.ts`).
- [ ] The ES3C28P still behaves the same with the new firmware (build its env).
- [ ] Installed plugins show the right icon/text on the larger buttons.

## 4. Acceptance criteria
- The screen's maximum grid works without perceptible slowness and without memory errors.
- Reliable touch at all sizes allowed by the physical limit.
- Switching between the two boards does not require changing the configuration.
- `board_<name>.cpp` documented (pins, calibration, panel notes) so others can reproduce it.

## 5. Optional later
- **Several boards at the same time** (per-board profile: current page, grid and separate settings): ~2 days.
- Batch images / compression (if the performance item fails).
- Portrait orientation; screen without touch (display only + physical buttons).
