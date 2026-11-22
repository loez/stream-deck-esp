# How to create a plugin for Stream Deck ESP

*[Português](../CRIAR-PLUGIN.md)*

A plugin is a `*.deckplugin` folder with a `plugin.json`, a Node.js **service** (runs in the background) and, optionally, an HTML **configuration screen** per action.
You write the service with the **project SDK** (`sdk/deck-plugin.mjs`) and the screen with `/deck-ui.js` (served by the app). The low-level wire (messages) is in [`PLUGIN-PROTOCOL.md`](PLUGIN-PROTOCOL.md);
this guide covers **everything a plugin can use and how to install, distribute, develop and debug it**. Ulanzi Studio plugins also run here (section 16), but **nothing in the project depends on them**.

**Contents:** 1 Plugin or native feature? · 2 Quick start · 3 Structure · 4 `plugin.json` · 5 How the plugin runs · 6 The service (SDK) · 7 Icons, text, GIF and states · 8 Configuration screen · 9 Settings and secrets ·
10 Languages · 11 Talking to the app (local HTTP) · 12 Install and distribute · 13 Hot reload · 14 Dependencies · 15 Debug and test · 16 Ulanzi (legacy) · 17 Limits and best practices · 18 Recipes · 19 Quick reference

---

## 1. Plugin or native feature?
Before creating a plugin, check whether the app already does it. **Native features** (buttons that need no plugin):

| Native | What it does |
|---|---|
| Open / close an app, open a website, keyboard shortcut, type text, media and volume | system actions (cross-platform) |
| Multi-action (sequence, all at once, cycle, random) | several actions on one button |
| Pages, subfolders, automatic page switching by the focused app | navigation |
| **Resource Monitor** (CPU, GPU, RAM; ring or summary in bars/line) | live numbers from the computer, updates by itself |
| **Slider** (system volume, Spotify/Apple Music volume, brightness, timeline) | a merged button dragged with a finger; [`SLIDERS.md`](SLIDERS.md) |
| Your own image or **GIF** on a button | icon/animation chosen by the user |

**Use a plugin when** the button needs logic of your own: talking to an API or device (lights, air conditioner, projector, Spotify), showing a state that changes (build, e-mail, temperature), keeping its own settings with a configuration screen.
A plugin **draws the button's icon/text and reacts to the tap**; it does not receive finger drags (that belongs to the native slider) and does not touch the grid or the pages.

## 2. Quick start (5 minutes)
1. Copy `docs/exemplo-plugin/ola-mundo.deckplugin` to a folder of your own (e.g. `~/my-plugin`). Change the `id` in `plugin.json` to your own unique one (`com.yourname.myplugin`; action ids must start with it).
2. In the app: **Settings > Third-party Plugins > Import from another folder or .zip file** and choose the folder. The actions appear in the library on the right (one group per plugin). Drag one onto a button.
3. **Developing:** under **Plugin development**, paste your folder's path into **Link** (the plugin must be installed). From then on, **saving a file reloads only your plugin** and the board updates by itself (section 13).
4. See the plugin log on the Plugins screen itself (or `DECK_PLUGIN_LOG=1`, section 15).

## 3. Folder structure
```
my-plugin.deckplugin/
├── plugin.json              # required
├── plugin/app.js            # main service ("main")
├── plugin/deck-plugin.mjs   # copy of the SDK (sdk/deck-plugin.mjs)
├── pi/index.html            # configuration screen (optional, one per action)
├── resources/               # PNG/GIF/SVG icons
└── node_modules/            # already-installed dependencies (section 14)
```
The folder name does not need to end in `.deckplugin` when importing (the app names it), but **keep the `id` stable**: buttons store it.

## 4. `plugin.json`
```json
{
  "id": "com.example.helloworld",
  "name": "Hello World",
  "version": "1.0.0", "author": "You", "description": "short text",
  "icon": "resources/icon.png",
  "main": "plugin/app.js",
  "actions": [
    { "id": "com.example.helloworld.counter", "name": "Counter",
      "tooltip": "help text", "icon": "resources/icon.png",
      "ui": "pi/index.html",
      "states": [ { "name": "Default", "image": "resources/s0.png" }, { "name": "On", "image": "resources/s1.png" } ] }
  ],
  "locales": { "en": { "Olá Mundo": "Hello World", "Contador": "Counter" } }
}
```
| Field | Required | What it is for |
|---|---|---|
| `id` | yes | plugin identity (unique; do not change after publishing) |
| `name`, `version`, `author`, `description`, `icon` | `name` yes | shown on the Plugins screen and in the action library |
| `main` | yes | Node service (`.js`/`.mjs`) **inside** the folder (no `..` or absolute path) |
| `actions[]` | at least 1 | each action is a draggable library item |
| `actions[].id` | yes | unique id; in code you use the short name (what comes after the last dot) |
| `actions[].name`, `tooltip`, `icon` | no | name, hint and icon in the library |
| `actions[].ui` | no | HTML of the configuration screen (section 8) |
| `actions[].states[]` | no | ready-made icons (`image`); `[0]` is the default icon before the plugin sends one; use the others with `image: {state: n}` (section 7) |
| `locales` | no | translations of what the **app** shows for your plugin (section 10) |

Rules validated on import: `id`, `name`, `main` and an action with an `id`; `main` exists inside the folder; two plugins cannot have the same `id`.

## 5. How the plugin runs
The app starts the service **only when some button uses one of its actions**, in the plugin folder, like this:
```
node plugin/app.js 127.0.0.1 <port> <language> <legacy-version>
        argv[2]    argv[3]  argv[4]  argv[5]
```
The SDK reads this by itself. Details:
- The bundled Node is **24** (global `WebSocket` and `fetch` exist). The process inherits the app's environment (for example `DECK_PORT`, the server port; the default is 8765).
- If the service **crashes**, the app restarts it with increasing backoff; more than **5 crashes in 60 s** and it gives up (the Plugins screen shows "failed"; reloading right away unlocks it).
- When no button uses the plugin, the process is stopped. **Do not keep button state in a file**: rebuild it in `onAdd` (the app re-sends `button.add` on every start).
- By default the service **exits when the app closes** the connection (`plugin.onClose`).
- It runs with the **user's permissions**. Only install plugins you trust.

## 6. The service (SDK `deck-plugin.mjs`)
Copy `sdk/deck-plugin.mjs` into the plugin (the app does not run `npm install`). Zero dependencies.
```js
import { Plugin } from './deck-plugin.mjs';
const plugin = new Plugin();               // address/port: process arguments; id: plugin.json of the current folder
plugin.action('counter', {                 // short name (after the last dot of the action id) or the full id
  onAdd:      (b) => b.set({ text: 'Taps\n0' }),   // the button appeared (b.settings = saved settings)
  onRemove:   (b) => {},
  onPress:    (b) => { b.state.n = (b.state.n || 0) + 1; b.set({ text: `Taps\n${b.state.n}` }); b.toast('ok'); },
  onDown:     (b) => {}, onUp: (b) => {},    // press / release (on every tap: down, press, up)
  onSettings: (b, settings) => {},           // the button's settings changed (here or on the screen)
  onActive:   (b, active) => {},             // the button's page entered/left the board: pause expensive work when false
  onMessage:  (b, payload) => {},            // message from the configuration screen
});
```
Handlers may be `async`; an error inside them goes to the plugin log and does **not** bring the service down.

**`Button`** (a button that uses one of your actions)
| Member | What it does |
|---|---|
| `id`, `action`, `key`, `settings`, `state`, `active` | identity (`key` = `column_row`), saved settings, **`state` = free space for you (not persisted)**, page active on the board |
| `set({ image, imageFile, gif, gifFile, text })` | changes icon/text; whatever you don't pass stays as it was |
| `toast(msg)` | short notice, returned as the result of the tap (on the board the button flashes a green border; the text shows when testing the button from the page) |
| `alert()` | signals the button failed (for now it only logs in the app, with no visual effect on the board) |
| `save(settings)` | stores **this button's** settings (persists; calls `onSettings` here and on the screen) |
| `sendToUI(payload)` | sends a message to this button's open configuration screen |

**`Plugin`**
| Member | What it does |
|---|---|
| `action(name, handlers)` | registers an action |
| `list([action])` | active buttons (optionally only of one action): to update several at once |
| `getGlobal()` → `Promise` · `setGlobal(obj)` | the plugin's **global** settings (persist) |
| `openUrl(url[, params])` | opens an http/https address in the user's browser |
| `hotkey('cmd+shift+4')` | presses a shortcut on the computer (`cmd` becomes Ctrl outside the Mac) |
| `language` | `'pt-BR'` or `'en'` (app language, fixed while the plugin runs) |
| `log(msg, level)` | writes to the plugin log (`info`, `warn`, `error`) |
| `ready` · `onClose` · `send(msg)` | connection promise · what to do when the app is lost · raw protocol message (advanced use) |

## 7. Icons, text, GIF and states
`b.set(...)` accepts:
- `image`: data URI (PNG/JPG/GIF/SVG) or a PNG `Buffer`. **`imageFile`**: a path inside the plugin folder (`'resources/x.png'`).
- `gif` (base64 or `Buffer`) / **`gifFile`**: **animates** the button.
- `text` (with `\n`): drawn **by the app** over the icon, **only if the user ticked "show on the board the text the plugin sends"** on the button (by default the button's name is theirs). `null` clears it.
- With no icon of your own: the action's `states[0].image` (or its `icon`) applies. To use another manifest state send the raw message: `plugin.send({ type: 'button.set', id: b.id, image: { state: 1 } })`.

Rules and tips:
- **Square** icon, 144x144 is the default; the app fits it to the button (on a **merged** button the icon grows with the shorter side). Draw with margins: the name strip covers the bottom when the button has a title.
- Re-sending the **same** icon costs nothing (the app compares), but don't send `set` at a high frequency: every new icon re-sends the image to the board. Update at most once per second.
- **GIF:** at most **8 animated buttons per page** and ~3 MB of frames per page (the board has little RAM; the app drops frames if it goes over); file up to 25 MB. Prefer few frames and a small icon.
- To generate icons without a library, an SVG data URI does it (see `plugins-proprios/bateria-esp.deckplugin`, and the solid-color PNG in the example).

## 8. Configuration screen (`ui`)
If the action has `ui`, the app opens that HTML in an iframe of the configuration page when the button is selected. Include `<script src="/deck-ui.js"></script>`; the page receives `port`, `address`, `id` (the button's), `plugin`, `action`, `key`, `language` in the URL.
```html
<script src="/deck-ui.js"></script>
<form id="f"><input name="color"><button>Save</button></form>
<script>
  const ui = new DeckUI();
  ui.onSettings((s) => DeckUI.setFormValue(s, '#f'));                 // fills now and on every change
  document.getElementById('f').onsubmit = (e) => { e.preventDefault(); ui.save(DeckUI.formValue('#f')); };
  ui.onMessage((payload) => { /* message from the service (b.sendToUI) */ });
  ui.send({ type: 'test' });                                           // goes to the button's onMessage
  // ui.getGlobal() -> Promise · ui.setGlobal(obj) · ui.ready · ui.id · ui.language ('pt_BR' | 'en')
</script>
```
Utilities: `DeckUI.formValue(form)`, `DeckUI.setFormValue(values, form)`, `DeckUI.debounce(fn, ms)` (save while typing), `DeckUI.query('name')`.
- The screen only acts on its **own** button (the app ignores the `id` it sends). It does **not** receive the echo of its own `save` (otherwise the form would jump back while typing).
- Only **the plugin's** files are served (never `config.json`, `devices.json`, `channels.json`, `buttons.json`, `*.pem`, `package*.json`).
- Style it to match the app's dark look (background `#16171b`, light text). To talk to the service (list devices, test a key) use `ui.send` and answer with `b.sendToUI`.

## 9. Settings and secrets
| What | Where it lives | API |
|---|---|---|
| **One button's** settings (color, device, interval) | the app's `config.json` (with the button; gone when the button is deleted) | `b.settings`, `b.save()`, `onSettings`; on the screen: `ui.save`, `ui.onSettings` |
| The plugin's **global** settings (account, preferences) | an app file, per plugin (deleted when you delete the plugin) | `getGlobal()`, `setGlobal()` |
| **Secrets** (tokens, keys, certificates) | `config.json` or `*.pem` **in the plugin folder** (0600, never served) | Node's `fs` |
Run-time state (counters, cache) lives in the service's memory (`b.state`); it is rebuilt on every start.

## 10. Languages
The app is pt-BR and English ([`TRANSLATION.md`](TRANSLATION.md)). The service reads `plugin.language` (`'pt-BR'` | `'en'`; fixed until the plugin restarts, which on a language change only happens when the app restarts) and the screen reads `ui.language`.
To translate what the **app** shows for your plugin (name, description, actions, hints), use `locales` in `plugin.json` (the key is the original text; without a translation the original shows). What the **plugin** sends (`toast`, `text`) and the screen itself, you translate.

## 11. Talking to the app (local HTTP)
Your service can query and control the app over HTTP at `http://127.0.0.1:${process.env.DECK_PORT || 8765}`. These are **local** calls (no token; requests from other sites are refused). Useful ones:

| Call | What for |
|---|---|
| `GET /api/resources` | `{cpu, gpu, ram:{percent, usedGB, totalGB}}` of the computer (CPU on the first reading is `null`) |
| `GET /api/status` | board connected, `battery` (`percent`, `volts`), `display` (brightness/screen off), current page |
| `POST /api/display` `{op: up\|down\|set\|off\|on\|toggle, value?}` | the board's brightness and screen off |
| `GET /api/config` · `GET /api/settings` | pages, buttons and grid |
| `POST /api/current/<page>` | show a page on the board |
| `POST /api/test/<page>/<slot>` | "tap" a button (runs its action) |
| `GET /api/preview/<page>/<slot>.png` | a button's current image |
| `GET /api/usb` | state of the board's cable connection ([`USB-PROTOCOL.md`](USB-PROTOCOL.md)) |
`plugins-proprios/bateria-esp.deckplugin` is the real example: it reads `/api/status` and calls `/api/display`. Avoid tight loops; 2 to 5 seconds are enough.

## 12. Install and distribute
Under **Settings > Third-party Plugins**:
- **Install from GitHub or a .zip:** paste the URL of a **public** repository (`https://github.com/owner/repo`, `owner/repo`, or a folder: `https://github.com/owner/repo/tree/<branch>/<folder>`). The app downloads the `.zip` (max. 100 MB), finds the plugin (at the root or in subfolders, up to 3 levels; if there are several, the message lists the folders and you use the `/tree/...` URL) and installs it. The branch/tag name cannot contain `/`.
- **Drag a `.zip`** onto the screen area, the grid or anywhere in the window: the server validates and installs it (max. 200 MB; protected against "zip slip").
- **Import from another folder or .zip:** `Choose folder…`, `Choose .zip…` or paste the full path. **Look for plugins in Ulanzi Studio** copies the ones already installed there (macOS/Windows only).
- **Update:** installing again a plugin with the **same `id`** (by URL or .zip) **updates in place**: buttons and local settings (`config.json`, certificates, `buttons.json`) stay and the service restarts. Importing by folder with an id that already exists is refused ("already exists"): use the linked folder (section 13), URL or .zip.
- **Delete:** the plugin's **Delete** button: stops the service, removes the folder and the global settings and **clears every button that uses one of its actions** (on all pages and subfolders; a merged button keeps its size). It cannot be undone.
- The app **validates the manifest**, **copies** it to the plugins folder (macOS: `~/Library/Application Support/Stream Deck ESP/plugins/`; on other systems, `plugins/` inside the app data, or `DECK_PLUGINS_DIR`), ignores `.git`/`__MACOSX` and symlinks pointing outside, leaves `config.json`/`*.pem` at 0600 and **never executes anything** during installation.
- Installing by URL/.zip asks for confirmation (**plugins run with the app's permissions**).

**Publishing on GitHub:** put `plugin.json` at the repository root (or in a folder and share the `/tree/...` URL), **include an already-installed `node_modules`** if you use dependencies (the app does not run `npm install`), keep the `id` stable and bump `version` on every change. Whoever has the URL installs and updates by pasting it again.
Endpoints (localhost only, with the exact `Content-Type`: `application/json` or `application/zip`; requests with another site's `Origin` are refused): `POST /api/plugins/install-url {url}`, `POST /api/plugins/upload` (body = the .zip), `POST /api/plugins/import {path}`, `DELETE /api/plugins/<id>`. Code: `node/src/plugin-install.ts` and `PluginHost.importFromPath`.

## 13. Hot reload (development)
Under **Plugin development** (same screen; `POST /api/plugins/dev`):
- **Link folder:** point to the folder with **your code** (with the same `id` as the installed plugin). When you save a file in it, the app validates `plugin.json`, copies it over the installed copy and **restarts only that plugin**; the board updates by itself, without restarting the app. A manifest broken mid-edit: the error shows on screen and **the previous version keeps running**.
- **Developer mode:** reloads a plugin when you save files of the **installed copy itself**. Files the plugin writes on its own (`config.json`, `buttons.json`, `devices.json`, `state.json`, `settings.json`...) do not trigger a reload (avoids loops). It reacts to `.js .mjs .cjs .html .css .json` and images.
- **Reload** (button): restarts the plugin immediately (also clears the "failed" state). The screen shows "Reloaded at hh:mm:ss (reason)".
- Your buttons, the button's settings and the global ones are **not** lost on reload. Changing the **`id`** is a different thing: unlink and install again.
- The preference is kept in `plugin-dev.json` in the app data (`DECK_DATA`).

## 14. Dependencies (`node_modules`)
The app **does not run `npm install`** on import: ship the `node_modules` ready inside the folder (or use no dependencies, like the example). Native modules must be compiled for the system and architecture of whoever will use them (macOS, Windows and Linux): **prefer plain JavaScript**.
The server bundles `ws` and `@napi-rs/canvas`, but this **does not apply to the plugin** (each plugin resolves from its own folder). `WebSocket` and `fetch` already exist in Node 24.

## 15. Debug and test
- **Plugin log** (last lines of stdout/stderr and of `plugin.log()`): the Plugins screen, or `curl localhost:8765/api/plugins` (the `log` field). Live in the terminal: `DECK_PLUGIN_LOG=1` when running the server (`cd node && ./iniciar.sh`).
- **Isolated instance** (does not touch your data): `DECK_DATA=$(mktemp -d) DECK_PORT=8821 DECK_PLUGIN_PORT=3927 DECK_NOMDNS=1 DECK_DRYRUN=1 DECK_PLUGINS_DIR=$DECK_DATA/plugins DECK_ULANZI_DIR=$DECK_DATA/none node src/main.ts`.
- **Without the board:** assign with `POST /api/button/<page>/<slot>/plugin` `{"plugin":"<id>","action":"<action id>"}`, tap with `POST /api/test/<page>/<slot>` (returns the `toast`) and see the icon at `GET /api/preview/<page>/<slot>.png`.
- **Automated tests** (use as a model): `cd node && npm run test:sdk` (SDK against a fake host), `npm run test:deck` (real host + protocol v2: simulated screen, settings, security), `npm run test:plugins` (Ulanzi's legacy language), `npm run test:install` (install by URL/.zip and hot reload).
- Common errors: an immediate `EHOSTUNREACH` on macOS = **Local Network** permission denied to the app (Settings > Privacy & Security > Local Network; the app warns on the Plugins screen); "failed" = the service crashed 5 times in 60 s (see the log); a grey button/`...` = the plugin has not sent an icon yet.

## 16. Ulanzi Studio plugins (legacy)
`*.ulanziPlugin` folders (with `manifest.json` and Ulanzi's SDK inside) are still imported and run here, speaking the old language which the host translates (`node/src/plugin-protocol.ts`). Only plugins whose service is JavaScript (Type `JavaScript`, `CodePath` `.js`); what runs in their browser (HTML, e.g. OpenWeather) is **not** supported.
To take Ulanzi's SDK out of them use `sdk/adaptar-plugin.mjs` (and `sdk/migrar-tela.mjs` for the screens); details in [`PLUGIN-PROTOCOL.md`](PLUGIN-PROTOCOL.md), section 7. Dial/encoder, `selectdialog` and `openview` do not exist here.

## 17. Limits and best practices
- **Security:** the plugin runs with the user's permissions; only install from people you trust. The host's WebSocket stays on `127.0.0.1` only, accepts pages only with the app's own `Origin` and **one connection per plugin** (the first wins, and only from plugins the app started).
- **Secrets** in `config.json`/`*.pem` in the plugin folder (0600, not served), never in the code or the repository. When publishing, **do not push** your `config.json` (an update also preserves the user's).
- **Fixed port:** if the plugin opens a server of its own, make the port **configurable**: Ulanzi Studio may be open and conflict (this happened with a bundled plugin on port 30901).
- **Powered-off devices** vanish from the network: handle connection errors with spaced retries (backoff). Do not leave a rejected promise unhandled in loops.
- **Shortcuts and opening addresses** go through the app (`hotkey`, `openUrl`): do not call `open`/`osascript`/`xdotool` from the plugin if you can avoid it; the app uses the right mechanism for each system.
- **Board:** little RAM and a small screen. Few animated icons, simple icons, short texts (the board font lacks some symbols: arrows, ✓ etc. become ASCII equivalents or disappear).
- **Node.js only** (the app does not run Python/Go in a managed way, although a plugin can use `child_process`).
- **Cross-platform:** the app runs on macOS, Windows and Linux. Test on more than one if you can; use `path`, never fixed slashes.
- **Button state:** rebuild it in `onAdd`/`onRemove`; use `onActive` to pause queries when the page is not on the board.

## 18. Recipes
**Counter with settings** (the full example is in `docs/exemplo-plugin/`):
```js
plugin.action('counter', {
  onAdd:   (b) => draw(b),
  onPress: (b) => { b.state.n = (b.state.n || 0) + 1; draw(b); b.toast(`Taps: ${b.state.n}`); },
  onSettings: (b) => draw(b),                           // the color came from the configuration screen
});
const draw = (b) => b.set({ image: icon(b.settings.color || 'blue'), text: `Taps\n${b.state.n || 0}` });
```
**Query an API every 30 s only while the page is on the board:**
```js
setInterval(async () => {
  for (const b of plugin.list('weather').filter((x) => x.active)) {
    try { const r = await (await fetch(`https://api.example/weather?c=${b.settings.city}`)).json(); b.set({ text: `${r.temp}°C` }); }
    catch (e) { plugin.log(`weather: ${e}`, 'error'); b.set({ text: 'no data' }); }
  }
}, 30_000);
```
**Show the computer's CPU/RAM usage on a plugin button** (an alternative to the native Resource Monitor, for a look of your own):
```js
const BASE = `http://127.0.0.1:${process.env.DECK_PORT || 8765}`;
setInterval(async () => { const r = await (await fetch(BASE + '/api/resources')).json(); plugin.list('cpu').forEach((b) => b.set({ text: `CPU\n${r.cpu ?? '--'}%` })); }, 3000);
```
**Screen and service talking** (list devices on the screen):
```js
// service
plugin.action('light', { onMessage: async (b, p) => { if (p.type === 'list') b.sendToUI({ type: 'devices', list: await discover() }); } });
// screen
ui.onMessage((m) => { if (m.type === 'devices') fillSelect(m.list); }); ui.send({ type: 'list' });
```
**Global settings** (one account for all the plugin's buttons): `await plugin.getGlobal()` at start and `plugin.setGlobal({ token })` on the login screen (`ui.setGlobal`).

## 19. Quick reference
- Protocol messages, Host ↔ service ↔ screen tables: [`PLUGIN-PROTOCOL.md`](PLUGIN-PROTOCOL.md).
- Examples: `docs/exemplo-plugin/ola-mundo.deckplugin` (a counter with a configuration screen, no dependencies) and `plugins-proprios/bateria-esp.deckplugin` (a real plugin: battery, brightness and the board's screen).
- Host code: `node/src/plugins.ts`, `node/src/plugin-protocol.ts`, `node/src/plugin-install.ts`. SDKs: `sdk/deck-plugin.mjs` (service), `node/web/deck-ui.js` (screen).
- Native sliders: [`SLIDERS.md`](SLIDERS.md). Cable connection to the board: [`USB-PROTOCOL.md`](USB-PROTOCOL.md). Platforms: [`PLATFORMS.md`](PLATFORMS.md). Languages: [`TRANSLATION.md`](TRANSLATION.md).
