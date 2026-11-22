# Security / Segurança

## Reporting a vulnerability
Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting (Security tab → "Report a vulnerability") on this repository. / Não abra issue pública para falhas de segurança: use o relato privado de vulnerabilidade do GitHub (aba Security).

## Threat model (short)
- The server binds to all interfaces (the board must reach it) but **only localhost** can use the configuration API; board endpoints require the pairing token (`X-Deck`). Requests that install code (plugins) or replace the whole configuration (backup import) additionally require `Content-Type: application/json`/zip, which a cross-site web page cannot send without a CORS preflight (the server refuses it).
- Pairing: during a 90 s window the board receives the token once. Use it on a trusted network. "Revogar acesso" generates a new token.
- **Plugins execute code** with your user's permissions. Install only trusted plugins; installing from a GitHub URL or `.zip` downloads and runs third-party code.
- **Standalone mode** stores webhook / Home Assistant / MQTT secrets on the board's flash in clear text. Never commit or share flash dumps (`*.bin`), and erase them from the board (serial command `X`) before giving it away.
- Backups exported from the app leave tokens and passwords out unless you tick the option to include them; treat such files as secrets.
- Do not expose port 8765 to the internet.
