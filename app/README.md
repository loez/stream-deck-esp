# Stream Deck ESP (app para Mac)

App de barra de menu em Electron. O Electron é só a casca: o servidor é o mesmo código de `../node`, compilado em `app/server` e executado como **processo filho** (o executável do Electron em modo Node, `ELECTRON_RUN_AS_NODE`). Os plugins do Ulanzi também rodam assim (o servidor os inicia com `process.execPath`).

- **A placa depende do servidor, não da janela.** Fechar a janela destrói o Chromium (devolve memória); o servidor continua e o ícone da barra de menu abre a janela de novo.
- **Menu da barra:** abrir, estado da placa, parear (90 s), abrir ao ligar o Mac, pasta de dados, log, sair. Sair encerra o servidor.
- **Janela:** mínimo 720x520; a página se adapta (gaveta de ações, grade escalável).
- **Se a porta 8765 já tem um servidor** (ex.: `node/iniciar.sh`), o app pergunta se usa aquele ou sai.
- Se o app morrer sem avisar, o servidor percebe (`DECK_PARENT_PID`) e sai sozinho em ~4 s.

## Dados
| Modo | Onde |
|---|---|
| App instalado | `~/Library/Application Support/Stream Deck ESP/{dados,cache,plugins}`; log em `~/Library/Logs/Stream Deck ESP/servidor.log` |
| Desenvolvimento (`npm run dev`) | as pastas do projeto (`../data`, `../node/plugins`) |


## Comandos (em `app/`)
```
npm install && node node_modules/electron/install.js   # uma vez (o binário do Electron, ~100 MB, vem do GitHub)
npm run icon        # gera build/icon.icns e os ícones da barra de menu
npm run dev         # compila o servidor e abre o app usando as pastas do projeto
npm run dist        # gera dist/Stream Deck ESP-darwin-arm64/Stream Deck ESP.app
```
`npm run build:server` só compila o servidor (`../node/tsconfig.build.json` -> `app/server`) e copia `assets/` e `web/`.

## Permissões do macOS
O app é assinado "ad hoc" (sem conta da Apple): roda neste Mac sem aviso. Na primeira vez que um botão enviar atalho/texto, o macOS pede **Acessibilidade** e **Automação (System Events)** para "Stream Deck ESP": conceda uma vez (Ajustes do Sistema > Privacidade e Segurança). Essas permissões passam a ser do app, não do Terminal.

## Rede local (a placa achar o servidor)
A placa descobre o servidor por mDNS (`_streamdeck._tcp`). O app registra o serviço com o **`dns-sd` do macOS** (`dns-sd -R ... _streamdeck._tcp local 8765`, processo filho que fica vivo enquanto o app roda), que fala com o mDNSResponder do sistema. Mandar o multicast direto de dentro do app (o que o `bonjour-service` faz, e funciona no Terminal) falhava com `send EHOSTUNREACH 224.0.0.251:5353` mesmo com "Rede local" permitida, e antes derrubava o servidor em loop. Hoje o erro de mDNS nunca derruba o servidor (`advertise()` e `uncaughtException` em `node/src`). Para conferir de fora: `dns-sd -B _streamdeck._tcp local` deve listar "Stream Deck (Mac)". O `Info.plist` ainda declara `NSLocalNetworkUsageDescription`/`NSBonjourServices` (inofensivo).

## Notas
- Nome diferente de "Stream Deck" para não colidir com o app da Elgato.
- Memória (footprint): servidor ~50 MB ocioso; sem janela o app todo fica em torno de 130 MB; o servidor roda JS compilado (sem o "strip types" do Node, ~28 MB a menos).
- Testes do servidor (`cd ../node && npm test`) também passam rodando no Node do Electron: `ELECTRON_RUN_AS_NODE=1 app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron node/test/plugins.ts`.
