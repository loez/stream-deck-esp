# Third-party notices / Avisos de terceiros

Stream Deck ESP is MIT-licensed (see `LICENSE`). It includes or depends on the following third-party work.

## Bundled in this repository
| Component | License | Where |
|---|---|---|
| **Montserrat Medium** font (The Montserrat Project Authors) | SIL Open Font License 1.1 | `node/assets/montserrat.ttf`, `include/montserrat_ttf.h` (converted for the firmware); license text: `node/assets/LICENSES/Montserrat-OFL.txt` |
| **Lucide** icons (Lucide Contributors; includes some Feather icons, MIT) | ISC | `node/assets/icones/lucide.json`; license: `node/assets/icones/LICENSES/LUCIDE-LICENSE.txt` |
| **Simple Icons** brand logos (Simple Icons Collaborators) | CC0 1.0 | `node/assets/icones/simple.json`; license: `node/assets/icones/LICENSES/SIMPLE-ICONS-LICENSE.md` |

The brand logos are trademarks of their respective owners; they are included only so users can pick them as button images. Use is at the user's own responsibility.

## Downloaded at build time (not stored here)
- **LVGL** (MIT) and **ArduinoJson** (MIT), through PlatformIO (`platformio.ini`); Arduino-ESP32 / ESP-IDF (LGPL/Apache-2.0).
- **npm packages** (see `node/package.json`, `app/package.json`): `@napi-rs/canvas`, `bonjour-service`, `omggif`, `opentype.js`, `pngjs`, `serialport`, `ws`, `electron` and `@electron/packager` — all MIT or compatible licenses.

## Trademarks
"Stream Deck" is a trademark of Corsair Memory, Inc. / Elgato; "Ulanzi" is a trademark of its owner. This project is an independent, community project, **not affiliated with, endorsed or sponsored by** Elgato, Corsair or Ulanzi. Plugins made for Ulanzi Studio can be imported only for compatibility; no Ulanzi code or assets are distributed here.
