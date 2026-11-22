# Platforms: macOS, Windows and Linux

*[Português](../PLATAFORMAS.md)*

The server, the configuration page, the plugin host, rendering and the firmware are the same on all three systems. What differs lives in **`node/src/platform/`**
(`mac.ts`, `win.ts`, `linux.ts`; `index.ts` picks one by system, and `DECK_PLATFORM=darwin|win32|linux` forces one, used by the tests).
No other file calls `open`, `osascript`, `xdotool`, etc.: everything goes through `platform.*`.

| Feature | macOS | Windows | Linux |
|---|---|---|---|
| Open / close an app | `open`, `osascript` | `Start-Process`, `CloseMainWindow` (PowerShell) | `gio launch`/`gtk-launch` (.desktop), `pkill -x` |
| Open a website | `open` | `Start-Process` | `xdg-open` |
| Keyboard shortcut | System Events (needs **Accessibility**) | `SendKeys` | `xdotool key` (X11/XWayland) |
| Type text | pastes with Cmd+V | pastes with Ctrl+V | `xdotool type` (or `wtype` on Wayland) |
| Media / volume | see the table below | `keybd_event` | `playerctl`, `pactl`/`wpctl`; fallback: XF86 keys via `xdotool` |
| Monitor brightness (media action) | brightness key codes | WMI (laptop built-in screens only) | `brightnessctl` |
| Focused app (page switching) | `lsappinfo` | `GetForegroundWindow` (a resident PowerShell) | `xdotool getactivewindow` (X11/XWayland only) |
| App list and icons | `/Applications`, `plutil`, JXA, `sips` | Start Menu shortcuts (.lnk), `System.Drawing` | `.desktop` files and icon theme |
| Pick a folder / .zip | `osascript` | Windows Forms dialogs | `zenity` or `kdialog` (otherwise paste the path) |
| Open a plugin .zip | `ditto` (fallback: JS) | plain JS | plain JS |
| Import from Ulanzi Studio | `~/Library/Application Support/Ulanzi/...` | `%APPDATA%\Ulanzi\...` | (does not exist) |
| mDNS announcement for the board | `dns-sd` (in the app) | `bonjour-service` (JS, in the server) | `bonjour-service` (JS, in the server) |
| Battery, brightness and screen-off **of the board** | same | same | same |

**"Cmd" becomes Ctrl** outside the Mac (`cmd+c` copies on all three). `option` becomes Alt.

## What to install
- **Windows:** nothing (PowerShell 5.1 ships with the system). The firewall asks once whether the app may use private networks: allow it (the board needs it).
- **Linux:** `xdotool` (shortcuts, typing, focused app), `playerctl` and `pactl` (media/volume; `wpctl` works on PipeWire), `brightnessctl` (brightness), `zenity` (folder picker), `xdg-utils`.
  On **pure Wayland** `xdotool` only sees XWayland windows: automatic page switching and shortcuts may not work (use `wtype` for typing). On GNOME/KDE with X11 everything works.
  The tray icon needs an AppIndicator extension on GNOME. Avahi (`avahi-daemon`) helps mDNS but is not required.
- **macOS:** Accessibility permission (shortcuts, typing, media) and Local Network, as before.

When a tool is missing, the button shows a message like `install xdotool ...` instead of failing silently.

## Running and packaging
- Server alone: `node/iniciar.sh` (macOS/Linux) or `node\iniciar.cmd` (Windows); or `cd node && npm ci && npm start`.
- App (tray): `cd app && npm ci && npm run dist` packages **for the system it runs on** (output in `app/dist/`). Native modules (`@napi-rs/canvas`) belong to the system that ran `npm ci`, so each system's package is built on it (CI does this: `.github/workflows/ci.yml`).
- App data: `app.getPath('userData')` (macOS `~/Library/Application Support/Stream Deck ESP`, Windows `%APPDATA%\Stream Deck ESP`, Linux `~/.config/Stream Deck ESP`).
- Icons: `npm run icon` generates `.icns` (macOS only), `.ico` and `.png`; the generated files are versioned in `app/build/`.

## Tests
- `npm test` (development machine, on a Mac): everything.
- `npm run test:ci`: the portable set (runs on macOS, Windows and Linux; `test/darwin.env` forces `DECK_PLATFORM=darwin` to check the macOS commands on any machine).
- `npm run test:platform`: the system layer (shortcuts, `.desktop`, PowerShell scripts without injection, commands generated for the three systems).

## Validation status
- macOS: everything tested on a real machine.
- Linux: server and tests (`test:ci`) in CI and in a Linux container; app packaging checked on both. **Not** tested on a real desktop: shortcuts, media and focused app depend on the tools above.
- Windows: server, tests (`test:ci`) and app packaging pass on the CI Windows runner (CI found and fixed a real bug: the `.git` filter in plugin import only understood `/`).
  The PowerShell scripts were checked by the PowerShell parser, but **shortcuts, media, focused-app switching and the Start Menu app list have not been exercised on a real Windows machine yet**: test them before relying on them.

### Media and volume buttons (validation per system)
| Button | macOS | Linux | Windows |
|---|---|---|---|
| Volume +, Volume -, Mute | AppleScript (the simulated HID key is ignored by recent macOS) — **validated on a real machine** | `pactl`/`wpctl` — **validated in CI and Docker with real PulseAudio** (`test/linux-media.ts`) | `keybd_event` — CI checks PowerShell accepts it (`test/windows-media.ts`); **effect not measured** |
| Play/Pause, Next, Previous | straight to Spotify/Music (AppleScript) — **validated** | `playerctl` (MPRIS) — **validated** with a fake player (`test/linux/mpris_mock.py`) | `keybd_event` — accepted by PowerShell; effect not measured |
| Brightness + / - | key codes 144/145 — built-in/Apple displays only; **an external monitor (e.g. on a Mac mini) does not respond** | `brightnessctl` — built-in screen only | WMI — built-in screen only |
| Now playing (cover/title) | Spotify/Music — **validated** | `playerctl` — **validated** (cover by http/file URL) | Windows media sessions (SMTC, via PowerShell/WinRT): Spotify, browser, Groove, VLC… — CI checks the API responds and the parser (accents/emoji/embedded cover); **reading a real track has not been proven** (the runner cannot create a media session) |
| Mute button with state | `output muted` — validated | `pactl get-sink-mute` — validated | `IAudioEndpointVolume.GetMute` — compiles and responds in CI (no sound card: null); real effect not measured |

Run the Linux validation on your machine (needs Docker): `cd node && bash test/linux/rodar-docker.sh`.

**Manual test script for Windows** (≈2 min, on a real machine with sound): (1) create Volume +, Volume -, Mute, Play/Pause, Next and Previous buttons; (2) with music playing in any player, tap each one on the page and check the effect; (3) create a "Now playing" button (Information group) while music plays in Spotify/browser: it should show cover, title and artist (the cover may take one track to appear); (4) tap the Mute button and check the red dot. If any fails, note which one and your Windows version.
