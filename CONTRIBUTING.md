# Contributing / Contribuindo

Thanks for helping! Issues and pull requests are welcome, in English or Portuguese.

## Setup
```bash
cd node && npm ci            # server (Node 22+; runs .ts directly)
cd ../app && npm ci          # Electron app (optional)
pip install platformio       # firmware
```

## Before opening a PR
- `cd node && npm run typecheck && npm run test:ci` must pass. `npm test` (full suite) needs macOS.
- Firmware changes: `pio run` must compile. Anything touching the board needs to be tested on hardware — say in the PR what you tested on which board.
- **Every user-visible string** goes through `tr()` (server) / `t()` (page) and gets an English entry in `node/src/locales/en.ts`; `npm run test:i18n` checks the page. Portuguese text is the translation key (see `docs/TRADUCAO.md`).
- **Everything system-specific** (open app, hotkeys, media, focused app) goes through `node/src/platform/{mac,win,linux}.ts`; never call `open`/`osascript`/`xdotool` elsewhere. Verify effects, not only exit codes (macOS simulated media keys return "ok" and do nothing).
- Don't make the project depend on the Ulanzi SDK/protocol; Ulanzi plugins are supported only through the compatibility layer.
- No secrets, personal data, flash dumps (`*.bin`) or your `data/` folder in commits.

## New board?
See `docs/ADAPTAR-PLACA.md` and add `docs/hardware/<BOARD>.md` (pins, panel quirks, touch calibration, photos).

## Layout
`src/`, `include/`, `platformio.ini` firmware · `node/` server + configuration page + tests · `app/` Electron app · `sdk/` plugin SDK · `docs/` documentation · `tools/` bench tools.
