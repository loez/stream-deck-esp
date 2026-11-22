# node/: servidor e página de configuração

*[English](README.en.md)*

Servidor do Stream Deck ESP em TypeScript (Node 22+ roda `.ts` direto, sem etapa de build; `npm run typecheck` confere os tipos).
Serve a página de configuração (`web/`), entrega à placa a configuração e as imagens e executa as ações quando a placa avisa um toque.

```bash
npm ci
npm start                # porta 8765, com mDNS; dados em ../data (config.json, token, uploads, cache)
npm run typecheck        # tsc --noEmit
npm test                 # suíte completa (precisa do macOS)
npm run test:ci          # subconjunto portável (macOS, Windows, Linux) usado pelo CI
```
Variáveis: `DECK_PORT`, `DECK_DATA` (pasta de config/token/uploads), `DECK_CACHE`, `DECK_NOMDNS=1`, `DECK_DRYRUN=1` (imprime os comandos em vez de executar), `DECK_NOPLUGINS=1`, `DECK_PLUGINS_DIR`, `DECK_PLUGIN_PORT` (3907), `DECK_PLUGIN_LOG=1`.
Para testar sem mexer na sua configuração: `DECK_DATA=$(mktemp -d) DECK_PORT=8799 DECK_NOMDNS=1 DECK_DRYRUN=1 npm start`.

## Módulos (`src/`)
| Arquivo | O que faz |
|---|---|
| `server.ts`, `main.ts` | HTTP (página em localhost, API da placa com token), pareamento, mDNS, tarefas periódicas (widgets, estado, recursos) |
| `config.ts`, `settings.ts` | páginas/botões (`config.json`), grade e fonte (`settings.json`), geometria pelo tamanho físico da tela |
| `actions.ts`, `netactions.ts` | ações (app, url, atalho, texto, mídia, sequência, página, webhook, Home Assistant, MQTT) e validação |
| `render.ts`, `fit.ts`, `resample.ts`, `anim.ts` | imagem dos botões (RGB565), texto, reamostragem, GIFs animados |
| `widgets.ts`, `nowplaying.ts`, `weather.ts`, `resources.ts`, `slider.ts`, `state.ts` | relógio, tocando agora, clima, monitor de recursos, controles deslizantes, botões com estado |
| `icones.ts` | biblioteca de ícones local (`assets/icones/`, gerada por `tools/gerar-icones.mjs`) |
| `backup.ts` | exportar/importar a configuração |
| `standalone.ts`, `sa-profile.ts` | modo autônomo (perfil enviado à placa) |
| `usb.ts`, `usb-port.ts` | conexão da placa por cabo (HTTP pela serial) |
| `plugins.ts`, `plugin-protocol.ts`, `plugin-install.ts` | host de plugins (formato `*.deckplugin`; compatibilidade com plugins do Ulanzi Studio) |
| `focus.ts`, `apps.ts` | troca de página pelo app em foco, lista de apps instalados |
| `platform/{mac,win,linux}.ts` | **tudo que é do sistema** (abrir app, atalhos, mídia, app em foco, volume): nunca chame `open`/`osascript`/`xdotool` fora dali |
| `i18n.ts`, `locales/en.ts` | idiomas (o texto em português é a chave) |

## Plugins
O host é `src/plugins.ts`; protocolo em `../docs/PROTOCOLO-PLUGIN.md`, guia em `../docs/CRIAR-PLUGIN.md`, SDK em `../sdk/`. Plugins instalados ficam em `node/plugins/` (ignorado pelo git) e **executam código com as permissões do seu usuário**.
Plugins do Ulanzi Studio (SDK 2.1.2) são suportados só por compatibilidade (importar, traduzir o protocolo em `plugin-protocol.ts`); o projeto não depende do SDK nem do protocolo da Ulanzi.
Segurança do host: WebSocket só em 127.0.0.1; páginas web só com `Origin` igual ao do servidor; arquivos de plugin servidos só de dentro da pasta dele e nunca `config.json`/`devices.json`/`*.pem`/`package*.json`; a ação "plugin" só vale com plugin e ação existentes.
Cuidado: dois hosts ao mesmo tempo (Ulanzi Studio e este) podem conflitar em plugins com recurso exclusivo (portas fixas, RPC).

## Troca automática de página pelo app em foco (`src/focus.ts`)
Uma página pode ser vinculada a apps; quando um deles vem para a frente, a placa mostra essa página, e ao ir para um app sem vínculo ela volta à página anterior. Só age quando o app em foco **muda**; Dock, Spotlight etc. não contam. O app em foco vem de `platform.front()` (macOS: `lsappinfo`, sem permissão extra; Windows: PowerShell; Linux: `xdotool`). Guardado em `config.json` (`pages[].apps`, `autoswitch:false` quando desligado).

## Testes (`test/`)
Cada arquivo é independente e sobe uma instância temporária do servidor em porta própria (88xx), sem mDNS e sem tocar nos seus dados. Os principais: `plugins.ts`, `sdk.ts`, `deck-plugins.ts`, `i18n.ts` (chaves da página x dicionário), `focus.ts`, `settings.ts`, `stride.ts`, `tiles.ts`, `anim.ts`, `platform.ts` (comandos gerados nos três sistemas), `usb.ts`, `slider.ts`, `netactions.ts`, `widgets.ts`, `standalone.ts`, `backup.ts`, `nowplaying.ts`, `state.ts`, `hold.ts`.
Validação de mídia real: `linux-media.ts` (com `test/linux/executar.sh` ou `bash test/linux/rodar-docker.sh`) e `windows-media.ts` (PowerShell); veja `../docs/PLATAFORMAS.md`.
