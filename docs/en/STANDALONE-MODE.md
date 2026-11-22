# Board standalone mode (without the app/PC)

*[Português](../MODO-AUTONOMO.md)*

When the app (or the computer) goes away, the board **takes over by itself** in a standalone mode over Wi-Fi: a **desk clock** (large time, date and weather) and, on touch, a **grid of smart-home buttons** that it runs itself (HTTP/HTTPS webhook, Home Assistant, MQTT).
When the server comes back (Wi-Fi or USB cable), it returns to normal mode by itself.

## How to use
1. **Smart-home buttons** (action library, group **Smart home**): *Webhook*, *Home Assistant* (with "Load entities"), *MQTT (publish)*, *Clock* and *Weather*. They also work in normal mode (the server runs/draws them) and have a **Test** button.
2. **Settings > Standalone mode:** turn it on, choose the **page** the board carries, the time zone (empty = the computer's), the weather **city**, 24 h, how long without touch returns to the clock, and **dim at night**. The list shows, for each button on the page, whether it **works without the PC** (webhook, Home Assistant, MQTT, clock, weather) or **needs the computer** (open app, shortcut, plugin...; those flash red in standalone mode).
3. With the board connected, the app sends the profile (the screen shows "Profile sent to the board ✓"). From then on, **closing the app** makes the board show the clock in ~12 s.

## When the board enters and leaves standalone mode
- It **enters** only when **there is no real server**: no USB cable **and** no HTTP response for 8 s (an error response, or a slow one, counts as a server being present), for another 4 s, after the first 20 s of boot (Wi-Fi and server discovery are still happening) **and** with a stored profile. So it never competes with a server that is there. It also works without Wi-Fi (time keeps running from the internal clock since the last sync).
- It **leaves** when the USB cable reappears or when the server answers (the board looks for it by mDNS every 5 s). The server's grid is downloaded again in full.
- Screen: full-screen clock; **touch** shows the profile grid; **no touch** for `idleReturnS` returns to the clock. At night (if enabled) brightness drops to the chosen % after 30 s without touch; any touch lights it up.
- Status bar: "Modo autonomo" (blue dot).

## Architecture
```
server (whenever connected)                    board (flash: LittleFS on the "spiffs" partition)
  standalone.json (config)  ─┐                  /sa/profile.json   ← committed last (profile.new → rename)
  sa-profile.ts: buildProfile ├─ GET /api/sa ──▶ /sa/img/<i>.raw    RGB565 image of each button
  netactions.ts (executors)   │  /api/sa/img/…   /sa/icon/<type>.raw 8 weather icons 48x48
  /api/deck: sa=<rev>, t=<epoch> ◀── &sa=<rev>   (the board reports the revision it has)
```
- **`/api/deck`** gained `sa` (profile revision; `"0"` = off/no profile → the board erases it) and `t` (server epoch, to set the time without internet). Secrets **never** go in `/api/deck`.
- **`GET /api/sa`** (board token or cable): JSON profile with `ex` (execution descriptor, **with tokens/passwords**) only on the buttons the board runs; `wd` (`clock`/`weather`) on the ones it draws; `tz` (POSIX TZ, e.g. `<-03>3`), `weather`, `clock`, `idle`, `night`, `geom`, `tiles`, `tx` (texts already in the app's language). `GET /api/sa/img/<i>.raw` and `GET /api/sa/icon/<type>.raw`.
- **Revision** = hash of the profile (includes each button's `imgrev`): changing a button or an option changes the revision and the board downloads again (at most every 30 s if it fails).
- **Time zone:** an IANA→POSIX TZ table in `node/src/sa-profile.ts` (103 zones, checked against `Intl` in the test); outside the table it becomes the current offset (no daylight saving).
- **Time:** NTP (`configTzTime`, `pool.ntp.org`/`time.google.com`) when there is Wi-Fi; without internet, the server clock (`t`) sets the board on every poll. With neither: `--:--`.
- **City by IP:** while no city has been chosen, the server finds an **approximate city from the public IP** (`ipwho.is`, HTTPS, no key; `locateByIp` in `weather.ts`) and uses it for the weather (marked "detected by IP"). **Privacy:** the service sees your public IP (unavoidable with this method) and nothing else; coordinates are rounded to 3 decimals. Detection is done **on the server**, never on the board. Choosing or clearing the city by hand turns automatic detection off (`locAuto`); the **Use my location (by IP)** button forces it again. On failure it retries every 10 min. `DECK_NOIPGEO=1` turns it all off; `DECK_IPGEO` points to another service (tests). The IP usually points to the ISP, so the city may be off by a bit: check it.
- **Weather:** Open-Meteo over **plain HTTP** every 20 min (1 min until the first reading): `current=temperature_2m,weather_code,is_day`; the WMO code becomes one of 8 icons (same map in `weather.ts` and `standalone.cpp`).
- **In normal mode** the Clock/Weather buttons are **images drawn by the server** (updated every 15 s); only in standalone mode does the board draw them live.

## Actions run by the board (`src/netexec.cpp`)
In a task of its own (16 KB stack in PSRAM), one at a time; the result becomes the button's green/red border.
- **Webhook:** method, body, content type and headers (`Name: value` per line); follows redirects; success = HTTP 2xx. HTTPS works.
- **Home Assistant:** `POST {url}/api/services/{domain}/{service}` with `Authorization: Bearer <token>` and body `{entity_id, ...data}`.
- **MQTT:** CONNECT/PUBLISH (QoS 0)/DISCONNECT by hand (MQTT 3.1.1), optional user/password, optional TLS, `retain`.
- **TLS:** mbedtls allocations go to **PSRAM** (`-Wl,--wrap=esp_mbedtls_mem_calloc` in `platformio.ini` + `__wrap_esp_mbedtls_mem_calloc` in `main.cpp`). Public domain: validates the **chain and the name** with the framework's root bundle; **IP or `*.local`**: does not validate (self-signed local server). **Known limitation** (pioarduino's mbedtls lacks `CONFIG_MBEDTLS_HAVE_TIME_DATE`): the certificate's **expiry date** is not checked.

## Secrets
Home Assistant tokens and MQTT user/password stay **in the board's flash** (`/sa/profile.json`, in clear text) while standalone mode is on. A full flash backup then contains these secrets (as it already contains the Wi-Fi password): **do not share or commit backups**.
They never go to logs. To erase: turn standalone mode off in the app (the board erases on the next contact) or send `X` over serial.

## Bench and tests
- `python3 tools/mock_services.py`: simulated webhook/Home Assistant/MQTT that print every request (test HA token: `teste-1234`); it proves that **the board** (not the server) ran the action with the app closed.
- Node: `npm run test:netactions` (25), `test:widgets` (18), `test:standalone` (26), `test:i18n`; they are part of `npm test`/`test:ci`.
- Firmware: builds with `pio run -e es3c28p`. On-board validation: section below.

## On-board validation script (flashing needs authorization; release the USB port first: `POST /api/usb {"enabled":false}`)
1. Flash the firmware, plug USB back, set up standalone mode (page + city) and wait for "Profile sent to the board ✓".
2. Close the app: in ≈12 s the clock appears with time, date and weather ("Modo autonomo" in the bar when you touch).
3. Run `tools/mock_services.py`, tap a Webhook/HA/MQTT button: the line shows up in the terminal and the button flashes green. A "Safari" button flashes red.
4. Reopen the app (or the cable): the board returns to normal mode by itself.
5. Leave it for 30 min with HTTPS in use: the `[dbg]` log should show stable internal RAM (goal ≥ 60 KB free).

## Validated on the real board (2026-11-22)
With the app closed: the clock appears by itself ≈20-30 s after boot (≈12 s after the server disappears with the board already on); touching shows the grid; **webhook** (POST with body and header), **Home Assistant** (Bearer) and **MQTT** were run **by the board** (checked in the `mock_services.py` logs); an "open app" button flashes red; **HTTPS** (`https://example.com`) returns 200 with chain and name validation, 3 taps in a row without a leak (internal RAM stable at 63-64 KB, PSRAM stable).
When the app was reopened the board returned to normal mode by itself, **over the cable and over Wi-Fi/mDNS** (≤ 15 s). Internal RAM: 115 KB before entering; ≈64 KB in standalone mode (the 16 buttons of the 4x4 grid as LVGL objects cost ~48 KB: the same as the normal 4x4 grid).

## Lessons (bugs found during validation)
- **Chunked response:** Open-Meteo answers with `Transfer-Encoding: chunked` and HTTPClient's `http.getStream()` is the raw connection: the JSON would not parse. Use `useHTTP10(true)` (or `getString()`).
- **ArduinoJson 7:** on a **const** variant (`JsonObjectConst`/`JsonVariantConst`) `is<JsonObject>()` is always false; use `isNull()` or `is<JsonObjectConst>()`.
- **Serial:** `pyserial` resets the board on every `open()` (USB-Serial/JTAG); use `tools/serial-sem-reiniciar.mjs` (Node `serialport` with `hupcl:false`) to observe. The snapshot (`P`) now captures the standalone clock when it is visible.

## Files
`node/src/netactions.ts`, `widgets.ts`, `weather.ts`, `standalone.ts`, `sa-profile.ts` · firmware: `include/standalone.h`, `src/standalone.cpp`, `src/netexec.cpp`, and the mode/clock state machine in `src/main.cpp` (`saEnter/saLeave/saApplyGrid/saPress/saSync`, `saUiTick`).
