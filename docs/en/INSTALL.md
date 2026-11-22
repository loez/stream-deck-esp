# Installing Stream Deck ESP (without Apple signing)

*[Português](../INSTALAR.md)*

Packages come from the GitHub **Releases** page (one per system; macOS has Apple Silicon and Intel builds).

## macOS
The app is neither signed nor notarized by Apple (that needs the paid developer account). macOS flags downloads as "quarantined" and,
without notarization, shows "app is damaged" or "unidentified developer". Three ways to clear it, once:

0. **`.dmg` installer (recommended):** open the `.dmg`, drag the app to Applications and double-click *"Liberar app (rodar depois de arrastar).command"* ("Release app (run after dragging)"); it removes the quarantine flag. If macOS refuses the `.command`, use option 1.
1. **Terminal:**
   ```
   unzip Stream-Deck-ESP-*-mac-*.zip -d /Applications
   xattr -dr com.apple.quarantine "/Applications/Stream Deck ESP.app"
   open "/Applications/Stream Deck ESP.app"
   ```
2. **Through the UI:** open the app (it will fail), then System Settings > Privacy & Security > "Open Anyway".

If you build on your own Mac (`cd app && npm run dist`) none of this applies: what you build has no quarantine flag.
The first time a button sends a shortcut/text, grant the app **Accessibility** and **Automation** permissions.

## Windows
Extract the zip and open `Stream Deck ESP.exe`. SmartScreen may warn (unsigned app): "More info" > "Run anyway".
The firewall asks once about private networks: allow it (the board needs it).

## Linux
`tar xzf Stream-Deck-ESP-*-linux-*.tar.gz` and run `Stream Deck ESP`. Dependencies: see [PLATFORMS.md](PLATFORMS.md).

## Building the packages
- **Publish (all platforms):** `git tag v1.0.0 && git push origin v1.0.0`. The `release` workflow builds on 4 runners, creates the Release and attaches the board firmware.
  To test without publishing: Actions > release > Run workflow (packages are kept as artifacts for 14 days).
- **Only on your Mac:** `cd app && npm run release` (produces `dist/Stream-Deck-ESP-<version>-mac-arm64.zip`).
