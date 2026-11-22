# Instalar o Stream Deck ESP (sem assinatura da Apple)

Os pacotes vêm da página **Releases** do GitHub (um por sistema; Mac tem Apple Silicon e Intel).

## macOS
O app não é assinado nem notarizado pela Apple (isso exige a conta paga). O macOS marca o que vem da internet como "quarentena" e,
sem notarização, mostra "app danificado" ou "desenvolvedor não identificado". Duas formas de liberar, uma vez só:

0. **Instalador `.dmg` (recomendado):** abra o `.dmg`, arraste o app para Applications e dê dois cliques em "Liberar app (rodar depois de arrastar).command" (tira a quarentena). Se o macOS recusar o .command, use a opção 1.
1. **Terminal:**
   ```
   unzip Stream-Deck-ESP-*-mac-*.zip -d /Applications
   xattr -dr com.apple.quarantine "/Applications/Stream Deck ESP.app"
   open "/Applications/Stream Deck ESP.app"
   ```
2. **Pela interface:** abra o app (vai falhar), depois Ajustes do Sistema > Privacidade e Segurança > "Abrir mesmo assim".

Quem compila no próprio Mac (`cd app && npm run dist`) não passa por isso: o que você gera não tem quarentena.
Na primeira vez que um botão mandar atalho/texto, conceda **Acessibilidade** e **Automação** ao app.

## Windows
Extraia o zip e abra `Stream Deck ESP.exe`. O SmartScreen pode avisar (app sem assinatura): "Mais informações" > "Executar assim mesmo".
O firewall pergunta uma vez pela rede privada: permita (a placa precisa).

## Linux
`tar xzf Stream-Deck-ESP-*-linux-*.tar.gz` e rode `Stream Deck ESP`. Dependências: ver `PLATAFORMAS.md`.

## Gerar os pacotes
- **Publicar (todas as plataformas):** `git tag v1.0.0 && git push origin v1.0.0` — o workflow `release` compila nos 4 runners e cria a Release.
  Teste sem publicar: Actions > release > Run workflow (os pacotes ficam como artefatos por 14 dias).
- **Só no seu Mac:** `cd app && npm run release` (gera `dist/Stream-Deck-ESP-<versão>-mac-arm64.zip`).
