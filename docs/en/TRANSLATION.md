# App languages (i18n)

*[Português](../TRADUCAO.md)*

The app is multi-language: **Brazilian Portuguese** (base) and **English**. The language is chosen in *Settings > Board and screen > Language*; it applies to the page, the server messages, the Electron app's menu/dialogs and plugins, and is kept in `settings.json` (`lang`: `pt` or `en`).
On first launch, with no choice made, the page follows the browser language (Portuguese if it is `pt*`, otherwise English); the Electron app follows the system language.

## How it works
The **Portuguese text is the key** (gettext style): with no translation, or in `pt`, nothing changes and the code stays readable.

| Where | How |
|---|---|
| Server (`node/src`) | `tr('text')`, `tr('hello {name}', { name })` (`src/i18n.ts`). JSON responses go through `trBody`, which translates the `erro`, `msg`, `why`, `toast` and `message` fields: so `send(res, 400, { erro: 'pedido inválido' })` already comes out translated. Messages built with values (`` `máximo de ${n} páginas` ``) are matched by `EN_PATTERNS` (regex → template with `$1`), or use `tr` with `{var}`. |
| Page (`node/web/index.html`) | `t('text')`, `t('hello {name}', { name })`, `plural(n, '1 item', '{n} items')`. Fixed HTML text: `data-i18n` (content) and the `title`/`placeholder`/`aria-label` attributes (translated automatically). The dictionary comes from `GET /api/i18n`. |
| Dictionary | `node/src/locales/en.ts` (`EN` and `EN_PATTERNS`), used by the server and sent to the page. |
| Electron app (`app/main.cjs`) | its own `EN` table at the top of the file and `L('text', {vars})`. |
| Plugins | the app passes the language when starting the plugin (`plugin.language`: `'pt-BR'` or `'en'`; fixed until the plugin restarts) and to the screen (`ui.language`, the URL's `language` parameter). Names and descriptions in `plugin.json` may have `"locales": { "en": { "<Portuguese text>": "<English text>" } }`. |

## Rules
- User data is **not** translated (page names, button titles). Names created by the app (new page, the subfolder's "Back" button) come out in the language at creation time and are then data like any other.
- Keep the same `{variables}` in the original and in the translation.
- No `${...}` inside `t('...')`: use variables.
- The board firmware (Wi-Fi portal, serial) is **not yet** translated.

## Adding a language
1. In `src/i18n.ts`, add the code to `LANGS`, the name to `LANG_NAMES` and the dictionary to `DICTS`; create `src/locales/<code>.ts` by copying `en.ts`.
2. In `app/main.cjs`, add the language table and adjust `lang()`/`L()`.
3. `cd node && npm run test:i18n` checks that every `t('...')` key in the page has a translation and that the `{variables}` match (today only for English: generalize the test for the new language).
