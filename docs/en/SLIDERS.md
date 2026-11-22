# Sliders on buttons

*[Português](../CONTROLES-DESLIZANTES.md)*

A **Slider** button (the "Slider" group in the library, or the type in the button's list) is dragged with a finger on the board. It works best on a wide (3x1) or tall (1x3) **merged** button: `Shift+click` the cells to merge them.
Code: `node/src/slider.ts` (logic), `render.ts` (`sliderCanvas`), `server.ts` (`POST /api/slide`, the `sl` field of `/api/deck`), `src/main.cpp` (`slEvent`/`slApply`, local drawing). Test: `node/test/slider.ts`.

## Modes
| Mode | Type | What it does |
|---|---|---|
| `volume` | absolute | the finger position is the system's master volume (macOS `osascript`, Linux `pactl`/`amixer`, Windows Core Audio) |
| `appvolume` | absolute | volume of **Spotify** or **Apple Music** (macOS: AppleScript, only if the app is already open; Linux: Spotify only via `playerctl`; Windows: not yet) |
| `brightness` | relative | dragging = steps on the brightness keys (macOS does not let you set absolute brightness) |
| `scrub` | relative | dragging = steps of a key (default ← →; also Shift+← →, ↑ ↓, J/K/L, `,` `.`): steps frame by frame on a video editor timeline |

**Honest limit:** the volume of an arbitrary app (Discord, a browser) **cannot** be controlled from outside on macOS without a virtual audio driver; only apps with their own control (Spotify, Music). Windows has per-app volume (audio sessions), but it is not implemented.

Action fields: `{type: 'slider', mode, app?: 'spotify'|'music', axis?: 'h'|'v', sens?: 4-80, inc?, dec?}`. Automatic `axis`: wider than tall = horizontal. `sens` = steps when dragging across the whole button (relative modes, default 24).

## How the board and the server talk
- `GET /api/deck?cap=tiles,anim,slide`: each slider button carries `sl: {o: 'h'|'v', v: level 0-1000, r: 0|1 relative, c: RGB color}`. Firmware without the `slide` capability does not get the field (the button shows only its icon).
- The button **image** (`/api/img/N.raw`) has only the track and the icon; the **fill is drawn by the firmware** (immediate response to the finger, without downloading an image on every movement). The page preview draws the fill at the current level.
- Finger on the button: `POST /api/slide/N?v=<0-1000>&p=<0|1|2>` (v = position along the button, left→right or bottom→top; p: 0 touched, 1 dragging, 2 released), at most every 60 ms. Over Wi-Fi or over the USB cable (tunnel, [USB-PROTOCOL.md](USB-PROTOCOL.md)).
- **Absolute:** the server keeps the level, applies it to the system and re-reads it from the system every 3 s (follows changes made elsewhere). A fast drag does not queue calls: it applies the first and then only the latest value.
- **Relative:** counts how far the finger moved (`steps = delta × sens`) and sends at most 30 keys at a time.
- During the drag (and for 1.5 s after) the board ignores the level coming from the server, so the fill does not "jump back" while the system is still applying.
