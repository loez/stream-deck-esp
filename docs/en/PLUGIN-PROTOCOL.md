# Stream Deck ESP plugin protocol (v2) and SDK

*[Português](../PROTOCOLO-PLUGIN.md)*

This document defines **what a plugin can do** and how it talks to the app. The **SDK** (`sdk/deck-plugin.mjs`, for the plugin service, and `/deck-ui.js`, for the configuration screen) is the way to write plugins;
the protocol below is what it speaks to the host (the server, `node/src/plugins.ts`, encoding in `node/src/plugin-protocol.ts`). Folder layout, manifest, installation (GitHub URL, .zip), hot reload, local HTTP and recipes: [CREATE-PLUGIN.md](CREATE-PLUGIN.md).

> **Independence.** Nothing in the project depends on the Ulanzi Studio SDK or protocol. The host only knows internal events; our own language (this one, v2) and the **legacy Ulanzi** one become the same events.
> The legacy language is still accepted **only to import and run plugins made for Ulanzi Studio** (section 7).

## 1. Concepts
- **Plugin**: a `*.deckplugin` folder with `plugin.json` and a Node service (`main`). The host starts it when any button uses one of its actions and restarts it if it crashes.
- **Action**: what a button does (declared in `actions` of `plugin.json`). **Button**: an assignment of an action to a position; identified by its **`id`** (the assignment id, a UUID the host keeps in `config.json` together with the settings). `key` = `column_row`.
- **Button settings** (`settings`): JSON saved by the host per button. **Global settings**: JSON per plugin. Secrets: a `config.json` file in the plugin folder (0600, never served).
- **Configuration screen (UI)**: optional HTML per action (`ui` in `plugin.json`), opened in an iframe of the app's page.

## 2. Service SDK (`sdk/deck-plugin.mjs`)
Copy the file into the plugin (the app does not run `npm install`). Zero dependencies.

```js
import { Plugin } from './deck-plugin.mjs';
const plugin = new Plugin();            // address/port: process arguments; id: plugin.json of the current folder
plugin.action('counter', {              // short name (what comes after the last dot of the action id) or the full id
  onAdd:      (b) => {},                // button appeared (b.settings = saved settings)
  onRemove:   (b) => {},
  onPress:    (b) => {},                // tap; onDown/onUp = press/release
  onSettings: (b, settings) => {},      // the button's settings changed
  onActive:   (b, active) => {},        // the button's page entered/left the board (pause expensive work when false)
  onMessage:  (b, payload) => {},       // message from the configuration screen
});
```
Handlers may be `async`; an error inside them goes to the plugin log and does **not** bring the service down.

| Object | Member | What it does |
|---|---|---|
| `Button` | `id`, `action`, `key`, `settings`, `state`, `active` | `state` is free space for you (not persisted) |
| | `set({ image, imageFile, gif, gifFile, text })` | changes icon/text; whatever you don't pass stays as it was |
| | `toast(msg)` · `alert()` | short notice (result of the tap) · marks the button as failed |
| | `save(settings)` | stores the button's settings (persists; calls `onSettings` here and on the screen) |
| | `sendToUI(payload)` | sends a message to this button's open configuration screen |
| `Plugin` | `list([action])` | active buttons (optionally only of one action) |
| | `getGlobal()` → Promise · `setGlobal(obj)` | the plugin's global settings |
| | `openUrl(url[, params])` · `hotkey('cmd+shift+4')` | open an http/https address · shortcut (`cmd` becomes Ctrl outside the Mac) |
| | `language` · `log(msg, level)` · `ready` · `onClose` | app language (`'pt-BR'` or `'en'`, comes in `argv[4]`) · plugin log · connection promise · the default is to exit together with the host |

`image` accepts a data URI (PNG/JPG/GIF/SVG) or a PNG `Buffer`; `gif` accepts base64 or a `Buffer` (animates the button); `*File` are paths inside the plugin folder. Square icon, 144x144 by default.
`text` (with `\n`) is drawn **by the host** over the icon, only if the user ticked "show plugin text" on the button. Re-sending the same icon costs nothing; don't send `set` at a high frequency.

## 3. Configuration screen SDK (`/deck-ui.js`)
The app serves this script; the plugin's page only includes it. It receives `port`, `address`, `id`, `plugin`, `action`, `key`, `language` in the URL.
```html
<script src="/deck-ui.js"></script>
<script>
  const ui = new DeckUI();
  ui.onSettings((s) => { /* fill the form with the button's settings (now and whenever they change) */ });
  ui.onMessage((payload) => { /* message from the service (b.sendToUI) */ });
  ui.save({ color: 'blue' });     // stores the button's settings
  ui.send({ type: 'test' });      // sends to the service (the button's onMessage)
  // ui.getGlobal() -> Promise · ui.setGlobal(obj) · ui.ready · ui.id / ui.language
</script>
```
The screen can only act on its **own** button (the host ignores the `id` it sends in messages).

## 4. The v2 wire (what the SDK sends and receives)
WebSocket `ws://127.0.0.1:<port>` (the port comes from `argv[3]`), JSON messages `{type, ...}`. No echo/acknowledgement. The button is always `id` (plus `action` and `key` in the host's messages).

**Registration** (first message): service `{type:'hello', protocol:2, role:'plugin', plugin:<id from plugin.json>}`; screen `{type:'hello', protocol:2, role:'ui', id:<button id>}`.

| Host → service | Becomes in the SDK |
|---|---|
| `button.add {id, action, key, settings}` | `onAdd` |
| `button.remove {id, action, key}` | `onRemove` |
| `button.down` · `button.press {settings}` · `button.up` (on every tap, in this order) | `onDown` · `onPress` · `onUp` |
| `button.active {active}` | `onActive` |
| `button.settings {settings}` (someone saved) | `onSettings` |
| `message {payload}` (from the screen) | `onMessage` |
| `global.settings {settings}` | resolves `getGlobal()` |

| Service → host | Comes from |
|---|---|
| `button.set {id, image:{data \| file \| gif \| gifFile \| state}, text}` — the button's full state; `state` = index into `states` of `plugin.json` | `Button.set` |
| `toast {message}` · `button.alert {id}` (today it only goes to the app log) | `toast()` · `alert()` |
| `button.settings.save {id, settings}` · `button.settings.get {id}` | `save()` |
| `ui.send {id, payload}` (to the screen) | `sendToUI()` |
| `global.get` · `global.set {settings}` | `getGlobal()` · `setGlobal()` |
| `open {url, params}` · `hotkey {keys}` · `log {level, message}` | `openUrl()` · `hotkey()` · `log()` |

| Screen → host | Host → screen |
|---|---|
| `button.settings.save {settings}` · `button.settings.get` | `button.settings {settings}` (on open and on every change) |
| `plugin.send {payload}` (to the service) | `message {payload}` (from the service) |
| `global.get` · `global.set {settings}` | `global.settings {settings}` |

## 5. Host guarantees and limits
- WebSocket on 127.0.0.1 only; pages only with the app's own `Origin`; **one connection per plugin** (the first wins) and only from plugins the app itself started.
- Plugins run with the user's permissions: import only those you trust. Node only (24).
- Plugin files are served only from inside its folder and never `config.json`, `devices.json`, `channels.json`, `buttons.json`, `*.pem`, `package*.json`.

## 6. Changing versions
`protocol: 2` in the `hello`. Compatible changes (new fields) do not change the number; the host ignores fields it does not know.

## 7. Ulanzi Studio plugins (legacy, kept for compatibility)
The app **still imports and runs plugins made for Ulanzi Studio** (a `*.ulanziPlugin` folder with `manifest.json`, a Node service, a screen using their library). They speak the old language
(`{cmd, uuid, key, actionid}`), which the host translates into the same internal events (`node/src/plugin-protocol.ts`: `decodeUlanzi`/`encodeUlanzi`). The first message (`connected` instead of `hello`) selects the language.
None of this is used by the project's own plugins. Two levels of use:

1. **Direct (changing nothing):** import the plugin; it runs as in Ulanzi Studio, with its SDK inside the folder.
2. **Adapted (without the Ulanzi SDK):** `sdk/ulanzi-compat.mjs` implements the `UlanziApi` class (the one from `plugin-common-node`) and the Ulanzi-style connection (`UlanziBridge`) **on top of our SDK**. The script only swaps the import:
```
node sdk/adaptar-plugin.mjs "<plugin-folder>"             # copies the SDK to <plugin>/deck-sdk/ and swaps the imports (keeps <file>.pre-deck-sdk)
node sdk/adaptar-plugin.mjs "<plugin-folder>" --desfazer   # back to the original ("undo")
node sdk/adaptar-plugin.mjs "<plugin-folder>" --refazer    # undo and adapt again (after updating the SDK) ("redo")
```
**Bundled** plugins (a minified `.js` with the Ulanzi SDK embedded, like **Spotify**): the script only swaps the host-client class inside the bundle for one built on our SDK. The patch is tied to the exact text of the original snippet:
on a different version of the plugin it **changes nothing** and warns. There is no automated test of the patch (only the check with the real plugin); when updating Spotify, re-import and run the script again.
**Configuration screens (HTML):** `node sdk/migrar-tela.mjs "<plugin-folder>" [--desfazer]` swaps Ulanzi's browser library (`libs/js/ulanziApi.js` and friends) for our `/deck-ui.js` (keeps `<file>.pre-deck-ui`; it only edits the installed copy and the screen stops working in Ulanzi Studio; if a call is left that the script does not know how to swap, it writes nothing).
Applied to real plugins and checked in a real browser (open, read what the service returns, save and see it in `config.json`). Screens that still use Ulanzi's library (e.g. Spotify's 14 pages, minified bundles) stay on the legacy language, which the host serves from inside the plugin folder.
In v2, the screen that saved does **not** receive its own echo (only the service and the button's other screens): otherwise the form would jump back while the user types.
Legacy coverage: add/run/clear/setactive/settings/globals/screen messages, icon types 0-4, toast, hotkey, openurl, log. Dial/encoder, `selectdialog` and `openview` do not exist here.

## 8. Tests
- `cd node && npm run test:sdk` — the SDK against a fake host and the `ulanzi-compat` layer (25 checks).
- `npm run test:deck` — the real host with protocol v2: a plugin written with the SDK, a simulated screen, button and global settings, security (forged id, Origin, second connection, another button's id), import and removal (32 checks).
- `npm run test:plugins` — the real host with a fake plugin in Ulanzi's legacy language (98 checks).
Examples: `docs/exemplo-plugin/ola-mundo.deckplugin` (a counter with a configuration screen) and `plugins-proprios/bateria-esp.deckplugin` (a real plugin).
