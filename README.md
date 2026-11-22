# Stream Deck ESP

**A touch-screen macro deck for ESP32-S3 boards, controlled by your own computer (macOS, Windows or Linux).**
Tap a button on the little screen and your computer opens an app, sends a shortcut, changes the volume, calls a webhook, toggles a Home Assistant light… no cloud, no account.

*[Leia em português](README.pt-BR.md)*

> Independent community project. Not affiliated with, endorsed or sponsored by Elgato, Corsair or Ulanzi (see [NOTICE.md](NOTICE.md)).

## What it does
- **Buttons with image and name**, in a grid from 2×2 up to 8×6 (what fits depends on the screen size, so fingers can hit them). Buttons can be merged into bigger ones and can show animated GIFs.
- **Pages and folders**, with next/previous/home/back/go-to buttons; the page can switch **automatically with the focused app**.
- **Actions:** open/close an app, open a URL, keyboard shortcut, type text, media keys & volume, multi-action sequences (in order, all at once, cycle, random), webhook, Home Assistant, MQTT.
- **On the board:** hold a button for an alternate action; swipe sideways to change page; sliders (volume).
- **Widgets:** clock, weather, now playing (cover, title, artist), resource monitor (CPU/GPU/RAM). Buttons can show state (light on/off, muted).
- **Offline icon library:** ~2,100 interface icons (Lucide) and ~3,500 brand logos (Simple Icons) bundled, with search and filters — nothing is fetched online.
- **Standalone mode:** if the computer is off, the board shows a desk clock/weather and still runs webhook / Home Assistant / MQTT buttons by itself.
- **USB cable mode** (HTTP tunnelled over the serial port) as an alternative to Wi-Fi.
- **Plugins** (own `*.deckplugin` format; Ulanzi Studio plugins can be imported for compatibility), backup/restore of the whole setup, UI in English and Brazilian Portuguese.

## How it works
```
 ESP32-S3 board (firmware, src/)  <--Wi-Fi (mDNS) or USB cable-->  desktop app (Electron + Node server, node/ and app/)
   draws the buttons (LVGL), reads touch                            config page at http://localhost:8765, runs the actions
```
The board finds the app by mDNS (`_streamdeck._tcp`), downloads button images, and reports touches. The server decides the layout from the screen size/density the board reports, so the same firmware logic works on different panels.

## Supported hardware
- **LCDWiki ES3C28P** (a.k.a. Fikra "Preta"): ESP32-S3, 2.8" 320×240 ILI9341 + FT6336G touch, 16 MB flash, 8 MB PSRAM — the reference board, tested.
- **Other boards:** the firmware is portable (one `src/board_<name>.cpp` per board). Needs an ESP32-S3 with PSRAM and a touch screen. See [docs/ADAPTAR-PLACA.md](docs/ADAPTAR-PLACA.md) *(Portuguese)*.

## Quick start
1. **App:** download the package for your system from the Releases page (macOS `.dmg`, Windows `.zip`, Linux `.tar.gz`; see [docs/INSTALAR.md](docs/INSTALAR.md) for the unsigned-app steps). Or run from source: `cd node && npm ci && npm start`, then open <http://localhost:8765>.
2. **Firmware:** `pip install platformio` then, with the board plugged in, `pio run -t upload`. (Back up the factory firmware first: [docs/hardware/ES3C28P.md](docs/hardware/ES3C28P.md).)
3. **Wi-Fi:** on first boot the board opens its own Wi-Fi portal to pick your network.
4. **Pair:** in the app, click **Parear placa** (pair board) and the board gets its access token. Done — configure buttons in the page.

## Development
```bash
cd node && npm ci && npm test          # server tests (npm run test:ci = the portable subset used by CI)
cd app  && npm ci && npm run dev       # desktop app in development (npm run dist = package for your OS)
pio run                                 # compile the firmware (add -t upload to flash)
```
CI (GitHub Actions) runs the server tests on macOS/Windows/Linux, a real PulseAudio + MPRIS media test on Linux, a PowerShell media test on Windows, compiles the firmware and packages the app.

## Platform status
| | macOS | Linux | Windows |
|---|---|---|---|
| Server, tests, packaging | tested on hardware | tested in CI + Docker | tested in CI |
| Shortcuts, media, focused-app switching | tested | needs `xdotool`, `playerctl`, `pactl` (media validated in CI) | PowerShell; **effects not yet confirmed on a real machine** |
Details and a manual Windows test script: [docs/PLATAFORMAS.md](docs/PLATAFORMAS.md).

## Documentation *(mostly Portuguese for now; contributions welcome)*
[Install](docs/INSTALAR.md) · [Platforms](docs/PLATAFORMAS.md) · [Standalone mode](docs/MODO-AUTONOMO.md) · [USB protocol](docs/PROTOCOLO-USB.md) · [Sliders](docs/CONTROLES-DESLIZANTES.md) · [Create a plugin](docs/CRIAR-PLUGIN.md) · [Plugin protocol](docs/PROTOCOLO-PLUGIN.md) · [Translations](docs/TRADUCAO.md) · [Adapt to another board](docs/ADAPTAR-PLACA.md) · [Hardware notes](docs/hardware/)

## Security model
The server listens on all interfaces so the board can reach it, but the configuration page and settings accept **localhost only**; the board authenticates with a token obtained in a 90-second pairing window. Do not expose port 8765 outside your LAN. **Plugins run code with your user's permissions** — install only plugins you trust. Standalone mode stores webhook/Home Assistant/MQTT secrets in the board's flash in clear text; never publish a flash dump. See [SECURITY.md](SECURITY.md).

## License
MIT — see [LICENSE](LICENSE). Third-party components: [NOTICE.md](NOTICE.md).
