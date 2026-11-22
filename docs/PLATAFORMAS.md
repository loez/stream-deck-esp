# Plataformas: macOS, Windows e Linux

*[English](en/PLATFORMS.md)*

O servidor, a página de configuração, o host de plugins, a renderização e o firmware são iguais nos três sistemas. O que muda fica em **`node/src/platform/`**
(`mac.ts`, `win.ts`, `linux.ts`; o `index.ts` escolhe pelo sistema, e `DECK_PLATFORM=darwin|win32|linux` força um, usado nos testes).
Nenhum outro arquivo chama `open`, `osascript`, `xdotool` etc.: tudo passa por `platform.*`.

| Recurso | macOS | Windows | Linux |
|---|---|---|---|
| Abrir / fechar app | `open`, `osascript` | `Start-Process`, `CloseMainWindow` (PowerShell) | `gio launch`/`gtk-launch` (.desktop), `pkill -x` |
| Abrir site | `open` | `Start-Process` | `xdg-open` |
| Atalho de teclado | System Events (precisa de **Acessibilidade**) | `SendKeys` | `xdotool key` (X11/XWayland) |
| Digitar texto | cola com Cmd+V | cola com Ctrl+V | `xdotool type` (ou `wtype` no Wayland) |
| Mídia / volume | veja a tabela abaixo | `keybd_event` | `playerctl`, `pactl`/`wpctl`; reserva: teclas XF86 do `xdotool` |
| Brilho do monitor (ação de mídia) | tecla de brilho | WMI (só tela interna de notebook) | `brightnessctl` |
| App em foco (troca de página) | `lsappinfo` | `GetForegroundWindow` (um PowerShell residente) | `xdotool getactivewindow` (só X11/XWayland) |
| Lista de apps e ícones | `/Applications`, `plutil`, JXA, `sips` | atalhos do Menu Iniciar (.lnk), `System.Drawing` | arquivos `.desktop` e tema de ícones |
| Escolher pasta / .zip | `osascript` | diálogos do Windows Forms | `zenity` ou `kdialog` (senão, colar o caminho) |
| Abrir .zip de plugin | `ditto` (reserva: JS) | JS puro | JS puro |
| Importar do Ulanzi Studio | `~/Library/Application Support/Ulanzi/...` | `%APPDATA%\Ulanzi\...` | (não existe) |
| Anúncio mDNS para a placa | `dns-sd` (no app) | `bonjour-service` (JS, no servidor) | `bonjour-service` (JS, no servidor) |
| Bateria, brilho e apagar a tela **da placa** | igual | igual | igual |

**"Cmd" vira Ctrl** fora do Mac (`cmd+c` copia nos três). `option` vira Alt.

## O que instalar
- **Windows:** nada (PowerShell 5.1 já vem no sistema). O firewall pergunta uma vez se o app pode usar a rede privada: permita (a placa precisa).
- **Linux:** `xdotool` (atalhos, digitar e app em foco), `playerctl` e `pactl` (mídia/volume; `wpctl` serve no PipeWire), `brightnessctl` (brilho), `zenity` (seletor de pasta), `xdg-utils`.
  No **Wayland puro** `xdotool` só enxerga janelas XWayland: a troca automática de página e os atalhos podem não funcionar (use `wtype` para digitar). No GNOME/KDE com X11 funciona tudo.
  O ícone da bandeja precisa de uma extensão AppIndicator no GNOME. Avahi (`avahi-daemon`) ajuda o mDNS, mas não é obrigatório.
- **macOS:** permissões de Acessibilidade (atalhos, digitar, mídia) e Rede Local, como antes.

Quando falta uma ferramenta, o botão mostra a mensagem `instale xdotool ...` em vez de falhar sem explicar.

## Rodar e empacotar
- Servidor sozinho: `node/iniciar.sh` (macOS/Linux) ou `node\iniciar.cmd` (Windows); ou `cd node && npm ci && npm start`.
- App (bandeja): `cd app && npm ci && npm run dist` empacota **para o sistema em que roda** (saída em `app/dist/`). Os módulos nativos (`@napi-rs/canvas`) são
  do sistema que fez o `npm ci`, então o pacote de cada sistema é gerado nele (o CI faz isso: `.github/workflows/ci.yml`).
- Dados do app: `app.getPath('userData')` (macOS `~/Library/Application Support/Stream Deck ESP`, Windows `%APPDATA%\Stream Deck ESP`, Linux `~/.config/Stream Deck ESP`).
- Ícones: `npm run icon` gera `.icns` (só no macOS), `.ico` e `.png`; os arquivos gerados ficam versionados em `app/build/`.

## Testes
- `npm test` (máquina de desenvolvimento, no Mac): tudo.
- `npm run test:ci`: o conjunto portável (roda em macOS, Windows e Linux; força `DECK_PLATFORM=darwin` por `test/darwin.env` para conferir os comandos do macOS em qualquer máquina).
- `npm run test:platform`: a camada de sistema (atalhos, `.desktop`, scripts do PowerShell sem injeção, comandos gerados nos três sistemas).

## Estado da validação
- macOS: tudo testado na máquina real.
- Linux: servidor e testes (`test:ci`) no CI e num container Linux; empacotamento do app conferido nos dois. **Não** testado num desktop real: atalhos, mídia e app em foco dependem das ferramentas acima.
- Windows: servidor, testes (`test:ci`) e empacotamento do app passam no runner Windows do CI (o CI achou e corrigiu um bug real: o filtro de `.git` na importação de plugins só entendia `/`).
  Os scripts do PowerShell foram validados pelo parser do PowerShell, mas **atalhos, mídia, troca por app em foco e lista do Menu Iniciar ainda não foram exercitados numa máquina Windows real**: teste-os antes de confiar.

### Botões de mídia e volume (validação por sistema)
| Botão | macOS | Linux | Windows |
|---|---|---|---|
| Volume +, Volume -, Mudo | AppleScript (a tecla HID simulada é ignorada pelo macOS recente) — **validado na máquina real** | `pactl`/`wpctl` — **validado no CI e no Docker com PulseAudio real** (`test/linux-media.ts`) | `keybd_event` — o CI confere que o PowerShell aceita (`test/windows-media.ts`); **efeito não medido** |
| Play/Pausa, Próxima, Anterior | direto no Spotify/Music (AppleScript) — **validado** | `playerctl` (MPRIS) — **validado** com player falso (`test/linux/mpris_mock.py`) | `keybd_event` — aceito pelo PowerShell; efeito não medido |
| Brilho + / - | códigos de tecla 144/145 — só telas internas/Apple; **monitor externo (ex.: Mac mini) não responde** | `brightnessctl` — só com tela interna | WMI — só tela interna |
| Tocando agora (capa/título) | Spotify/Music — **validado** | `playerctl` — **validado** (capa por URL http/file) | sessões de mídia do Windows (SMTC, via PowerShell/WinRT): Spotify, navegador, Groove, VLC… — o CI confere que a API responde e o parser (acentos/emoji/capa embutida); **a leitura de uma faixa real não foi provada** (o runner não cria sessão de mídia) |
| Botão Mudo com estado | `output muted` — validado | `pactl get-sink-mute` — validado | `IAudioEndpointVolume.GetMute` — compila e responde no CI (sem placa de som: null); efeito real não medido |

Rodar a validação do Linux na sua máquina (precisa do Docker): `cd node && bash test/linux/rodar-docker.sh`.

**Roteiro manual para o Windows** (≈2 min, numa máquina real com som): (1) crie botões Volume +, Volume -, Mudo, Play/Pausa, Próxima e Anterior; (2) com música tocando em qualquer player, toque em cada um na página e confira o efeito; (3) crie um botão "Tocando agora" (grupo Informações) com música tocando no Spotify/navegador: deve mostrar capa, título e artista (a capa pode demorar uma faixa); (4) toque no botão Mudo e confira a bolinha vermelha. Se algum não responder, anote qual e a versão do Windows.

