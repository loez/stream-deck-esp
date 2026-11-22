# Stream Deck ESP (desktop app)

*[Português](README.md)*

Menu-bar/tray app in Electron (macOS, Windows and Linux; the permission and mDNS details below are macOS-specific). Electron is only the shell: the server is the same code as `../node`, compiled into `app/server` and run as a **child process** (Electron's executable in Node mode, `ELECTRON_RUN_AS_NODE`). Ulanzi plugins also run this way (the server starts them with `process.execPath`).

- **The board depends on the server, not on the window.** Closing the window destroys Chromium (frees memory); the server keeps running and the menu-bar icon opens the window again.
- **Menu-bar menu:** open, board status, pair (90 s), open at login, data folder, log, quit. Quitting stops the server.
- **Window:** minimum 720x520; the page adapts (action drawer, scalable grid).
- **If port 8765 already has a server** (e.g. `node/iniciar.sh`), the app asks whether to use that one or quit.
- If the app dies without warning, the server notices (`DECK_PARENT_PID`) and exits by itself in ~4 s.

## Data
| Mode | Where |
|---|---|
| Installed app | `~/Library/Application Support/Stream Deck ESP/{dados,cache,plugins}` (macOS); log in `~/Library/Logs/Stream Deck ESP/servidor.log` |
| Development (`npm run dev`) | the repository folders (`../data`, `../node/plugins`) |

## Commands (in `app/`)
```
npm install && node node_modules/electron/install.js   # once (the Electron binary, ~100 MB, comes from GitHub)
npm run icon        # generates build/icon.icns and the menu-bar icons
npm run dev         # compiles the server and opens the app using the repository folders
npm run dist        # produces dist/Stream Deck ESP-darwin-arm64/Stream Deck ESP.app
```
`npm run build:server` only compiles the server (`../node/tsconfig.build.json` -> `app/server`) and copies `assets/` and `web/`.

## macOS permissions
The app is signed "ad hoc" (no Apple account): it runs on the Mac that built it without warnings. The first time a button sends a shortcut/text, macOS asks for **Accessibility** and **Automation (System Events)** for "Stream Deck ESP": grant them once (System Settings > Privacy & Security). These permissions then belong to the app, not to Terminal.

## Local network (the board finding the server)
The board discovers the server by mDNS (`_streamdeck._tcp`). The app registers the service with macOS's **`dns-sd`** (`dns-sd -R ... _streamdeck._tcp local 8765`, a child process that stays alive while the app runs), which talks to the system mDNSResponder. Sending multicast straight from inside the app (what `bonjour-service` does, and it works in Terminal) failed with `send EHOSTUNREACH 224.0.0.251:5353` even with "Local Network" allowed, and used to crash the server in a loop. Today an mDNS error never brings the server down (`advertise()` and `uncaughtException` in `node/src`). To check from outside: `dns-sd -B _streamdeck._tcp local` should list "Stream Deck (Mac)". `Info.plist` still declares `NSLocalNetworkUsageDescription`/`NSBonjourServices` (harmless).

## Notes
- Memory footprint: the server ~50 MB idle; with no window the whole app sits around 130 MB; the server runs compiled JS (without Node's "strip types", ~28 MB less).
- The server tests (`cd ../node && npm test`) also pass when run on Electron's Node: `ELECTRON_RUN_AS_NODE=1 app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron node/test/plugins.ts`.
