# Stream Deck ESP

**Um deck de macros com tela de toque para placas ESP32-S3, controlado pelo seu próprio computador (macOS, Windows ou Linux).**
Toque num botão da telinha e o computador abre um app, manda um atalho, muda o volume, chama um webhook, liga uma luz do Home Assistant… sem nuvem e sem conta.

*[Read in English](README.md)*

> Projeto comunitário independente. Sem vínculo, aval ou patrocínio da Elgato, Corsair ou Ulanzi (veja o [NOTICE.md](NOTICE.md)).

## O que faz
- **Botões com imagem e nome**, em grade de 2×2 até 8×6 (o que cabe depende do tamanho da tela, para o dedo acertar). Dá para juntar botões em maiores e usar GIFs animados.
- **Páginas e pastas**, com botões próxima/anterior/início/voltar/ir para; a página pode trocar **sozinha conforme o app em foco**.
- **Ações:** abrir/fechar app, abrir URL, atalho de teclado, digitar texto, teclas de mídia e volume, sequências de ações (em ordem, todas juntas, alternar, sorteio), webhook, Home Assistant, MQTT.
- **Na placa:** segurar um botão executa uma ação alternativa; deslizar o dedo troca de página; controles deslizantes (volume).
- **Widgets:** relógio, clima, tocando agora (capa, título, artista), monitor de recursos (CPU/GPU/RAM). Botões mostram estado (luz ligada/desligada, mudo).
- **Biblioteca de ícones offline:** ~2.100 ícones de interface (Lucide) e ~3.500 logos de marcas (Simple Icons) embutidos, com busca e filtros — nada é buscado na internet.
- **Modo autônomo:** com o computador desligado, a placa vira relógio/clima de mesa e ainda executa botões de webhook / Home Assistant / MQTT sozinha.
- **Conexão por cabo USB** (HTTP pela porta serial) como alternativa ao Wi-Fi.
- **Plugins** (formato próprio `*.deckplugin`; plugins do Ulanzi Studio podem ser importados por compatibilidade), backup/restauração de toda a configuração, interface em português e inglês.

## Como funciona
```
 placa ESP32-S3 (firmware, src/)  <--Wi-Fi (mDNS) ou cabo USB-->  app de desktop (Electron + servidor Node, node/ e app/)
   desenha os botões (LVGL), lê o toque                            página de configuração em http://localhost:8765, executa as ações
```
A placa acha o app por mDNS (`_streamdeck._tcp`), baixa as imagens dos botões e avisa os toques. O servidor calcula o layout pelo tamanho/densidade da tela que a placa informa, então a mesma lógica serve a painéis diferentes.

## Hardware suportado
- **LCDWiki ES3C28P** (Fikra "Preta"): ESP32-S3, tela 2,8" 320×240 ILI9341 + toque FT6336G, 16 MB de flash, 8 MB de PSRAM — a placa de referência, testada.
- **Outras placas:** o firmware é portável (um `src/board_<nome>.cpp` por placa). Precisa de ESP32-S3 com PSRAM e tela de toque. Veja [docs/ADAPTAR-PLACA.md](docs/ADAPTAR-PLACA.md).

## Começando
1. **App:** baixe o pacote do seu sistema na página de Releases (macOS `.dmg`, Windows `.zip`, Linux `.tar.gz`; para o app sem assinatura veja [docs/INSTALAR.md](docs/INSTALAR.md)). Ou rode do código: `cd node && npm ci && npm start` e abra <http://localhost:8765>.
2. **Firmware:** `pip install platformio` e, com a placa ligada por USB, `pio run -t upload`. (Faça antes o backup do firmware de fábrica: [docs/hardware/ES3C28P.md](docs/hardware/ES3C28P.md).)
3. **Wi-Fi:** no primeiro boot a placa abre o próprio portal Wi-Fi para escolher a rede.
4. **Parear:** no app, clique em **Parear placa** e a placa recebe a chave de acesso. Pronto: configure os botões na página.

## Desenvolvimento
```bash
cd node && npm ci && npm test          # testes do servidor (npm run test:ci = subconjunto portável do CI)
cd app  && npm ci && npm run dev       # app de desktop em desenvolvimento (npm run dist = empacota para o seu sistema)
pio run                                 # compila o firmware (com -t upload grava)
```
O CI (GitHub Actions) roda os testes do servidor em macOS/Windows/Linux, um teste de mídia real (PulseAudio + MPRIS) no Linux e de PowerShell no Windows, compila o firmware e empacota o app.

## Estado por sistema
| | macOS | Linux | Windows |
|---|---|---|---|
| Servidor, testes, empacotamento | testado no hardware | testado no CI e no Docker | testado no CI |
| Atalhos, mídia, troca por app em foco | testado | precisa de `xdotool`, `playerctl`, `pactl` (mídia validada no CI) | PowerShell; **efeitos ainda não confirmados numa máquina real** |
Detalhes e um roteiro de teste manual para o Windows: [docs/PLATAFORMAS.md](docs/PLATAFORMAS.md).

## Documentação
[Instalar](docs/INSTALAR.md) · [Plataformas](docs/PLATAFORMAS.md) · [Modo autônomo](docs/MODO-AUTONOMO.md) · [Protocolo USB](docs/PROTOCOLO-USB.md) · [Controles deslizantes](docs/CONTROLES-DESLIZANTES.md) · [Criar plugin](docs/CRIAR-PLUGIN.md) · [Protocolo de plugins](docs/PROTOCOLO-PLUGIN.md) · [Traduções](docs/TRADUCAO.md) · [Adaptar a outra placa](docs/ADAPTAR-PLACA.md) · [Notas de hardware](docs/hardware/)

## Segurança
O servidor escuta em todas as interfaces para a placa alcançá-lo, mas a página de configuração aceita **só localhost**; a placa se autentica com um token obtido numa janela de pareamento de 90 s. Não exponha a porta 8765 fora da sua rede local. **Plugins executam código com as permissões do seu usuário**: instale só os de confiança. O modo autônomo guarda segredos de webhook/Home Assistant/MQTT em claro na flash da placa; nunca publique um dump da flash. Veja [SECURITY.md](SECURITY.md).

## Licença
MIT — veja [LICENSE](LICENSE). Componentes de terceiros: [NOTICE.md](NOTICE.md).
