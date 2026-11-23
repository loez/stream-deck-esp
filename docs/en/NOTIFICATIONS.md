# Browser notifications on the board

*[Português](../NOTIFICACOES.md)*

Alerts that websites show in Chrome (Gmail, WhatsApp Web, etc.) appear on a **Notifications** button on the board. Tapping it opens the **history**, with scrolling.

## How it works
1. The `extension/` Chrome extension copies every notification a site creates (`new Notification(...)` and `registration.showNotification(...)`) and sends it to the local server's `POST /api/notify`, using its **own key** (`X-Deck-Notify` header), separate from the board's key.
2. The server keeps the last 50 alerts **in memory only** (gone when the app quits); the **Notifications** button shows the latest one and how many are unread.
3. Tapping the button opens a temporary page: **Back**, **▲/▼** (scroll the list; show the range `1-4/12`), **Clear** and the messages. Tapping a message **dismisses** it. The page is never saved to the configuration.

## Install
1. In the server page, open **Settings → Notifications** and copy the **port** and the **key**.
2. In Chrome: `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the project's `extension/` folder.
3. In the extension's options, paste the port and key and press **Send test**.
4. In the configuration page, add the **Notifications** button (widgets) to a page.

## Limits
- It only sees what the **site calls in the page itself**. *Push* notifications delivered by a service worker while the tab is closed do not go through the extension.
- Needs the computer on (does not work in the board's standalone mode); the board updates within ~1.5 s (Wi-Fi) or ~0.6 s (USB).
- Only requests from the computer itself (`127.0.0.1`) with the right key are accepted; **Generate new key** invalidates the old one. The server limits 30 alerts per minute and 400 characters per alert, and nothing is downloaded from links or icons.
- Alert contents may be private: they stay only in the server's memory and show on the board's screen.
