#!/bin/sh
# Inicia o servidor do Stream Deck (Node/TypeScript) e abre a página de configuração. macOS e Linux (no Windows: iniciar.cmd).
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install --no-audit --no-fund
case "$(uname -s)" in
  Darwin) OPEN=open ;;
  *) OPEN=xdg-open ;;
esac
(sleep 1.5; "$OPEN" "http://localhost:8765" >/dev/null 2>&1) &
exec node src/main.ts
