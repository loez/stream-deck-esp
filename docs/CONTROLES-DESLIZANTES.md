# Controles deslizantes (sliders) nos botões

*[English](en/SLIDERS.md)*

Um botão do tipo **Controle deslizante** (grupo "Controle deslizante" da biblioteca, ou o tipo na lista do botão) é arrastado com o dedo na placa. Funciona melhor em um botão **juntado** largo (3x1) ou alto (1x3): `Shift+clique` nas células para juntar.
Código: `node/src/slider.ts` (lógica), `render.ts` (`sliderCanvas`), `server.ts` (`POST /api/slide`, campo `sl` do `/api/deck`), `src/main.cpp` (`slEvent`/`slApply`, desenho local). Teste: `node/test/slider.ts`.

## Modos
| Modo | Tipo | O que faz |
|---|---|---|
| `volume` | absoluto | a posição do dedo é o volume geral do sistema (macOS `osascript`, Linux `pactl`/`amixer`, Windows Core Audio) |
| `appvolume` | absoluto | volume do **Spotify** ou do **Apple Music** (macOS: AppleScript, só se o app já estiver aberto; Linux: só Spotify via `playerctl`; Windows: ainda não) |
| `brightness` | relativo | arrastar = passos nas teclas de brilho (o macOS não deixa definir o brilho absoluto) |
| `scrub` | relativo | arrastar = passos de uma tecla (padrão ← →; também Shift+← →, ↑ ↓, J/K/L, `,` `.`): anda quadro a quadro numa linha do tempo de editor de vídeo |

**Limite honesto:** o volume de um app qualquer (Discord, navegador) **não** dá para controlar de fora no macOS sem um driver de áudio virtual; só apps com controle próprio (Spotify, Music). No Windows existe volume por app (sessões de áudio), mas não foi implementado.

Campos da ação: `{type: 'slider', mode, app?: 'spotify'|'music', axis?: 'h'|'v', sens?: 4-80, inc?, dec?}`. `axis` automático: mais largo que alto = horizontal. `sens` = passos ao arrastar o botão inteiro (relativos, padrão 24).

## Como a placa e o servidor conversam
- `GET /api/deck?cap=tiles,anim,slide`: cada botão-controle traz `sl: {o: 'h'|'v', v: nível 0-1000, r: 0|1 relativo, c: cor RGB}`. Firmware sem a capacidade `slide` não recebe o campo (o botão fica só com o ícone).
- A **imagem** do botão (`/api/img/N.raw`) tem só o trilho e o ícone; o **preenchimento é desenhado pelo firmware** (resposta imediata ao dedo, sem baixar imagem a cada movimento). A prévia da página desenha o preenchimento com o nível atual.
- Dedo no botão: `POST /api/slide/N?v=<0-1000>&p=<0|1|2>` (v = posição ao longo do botão, esquerda→direita ou baixo→cima; p: 0 encostou, 1 arrastando, 2 soltou), no máximo a cada 60 ms. Por Wi-Fi ou pelo cabo USB (túnel, `PROTOCOLO-USB.md`).
- **Absoluto:** o servidor guarda o nível, aplica no sistema e relê do sistema a cada 3 s (acompanha mudanças feitas por outro lado). Arrasto rápido não empilha chamadas: aplica a primeira e depois só o valor mais recente.
- **Relativo:** conta o quanto o dedo andou (`passos = delta × sens`) e envia no máximo 30 teclas por vez.
- Durante o arrasto (e 1,5 s depois) a placa ignora o nível vindo do servidor, para o preenchimento não "voltar" enquanto o sistema ainda aplica.
