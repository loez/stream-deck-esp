# Conexão da placa por cabo USB

*[English](en/USB-PROTOCOL.md)*

Além do Wi-Fi, a placa fala com o servidor pelo cabo USB (porta USB-Serial/JTAG do ESP32-S3). É um **túnel HTTP**: a placa faz os mesmos pedidos de sempre
(`GET /api/deck`, `GET /api/img/N.raw`, `GET /api/anim/N.bin`, `POST /api/press/N`), só que em quadros binários pela serial. O servidor repete cada pedido em `127.0.0.1`
com o token dele e devolve a resposta; toda a lógica (grade, imagens, ações, plugins) é a mesma. **Sem Wi-Fi, sem mDNS e sem pareamento: o cabo é a prova de identidade.**
Código: `node/src/usb.ts` (quadros, sessão), `node/src/usb-port.ts` (detecção da porta), `src/usblink.cpp` (firmware). Teste: `node/test/usb.ts`.

## Quadro
`A5 5A | tipo (1) | id (u16 LE) | tamanho (u32 LE) | xor dos 9 bytes anteriores | payload`

| Tipo | Sentido | Payload |
|---|---|---|
| 1 REQ | placa → servidor | método (1 = GET, 2 = POST) + caminho (`/api/...`, até 300 bytes) |
| 2 RES | servidor → placa | status HTTP (u16 LE) + corpo |
| 3 HELLO | servidor → placa, a cada 1 s | versão do protocolo (1 byte) |
| 7 PROBE | servidor → placa | vazio ("quem é você?") |
| 4 BEACON | placa → servidor | nome da placa (`streamdeck-esp`), só em resposta ao PROBE |

Os **logs de texto** da placa saem pela mesma porta; o servidor ignora tudo que não for quadro válido (o xor do cabeçalho evita falso positivo). Uma placa sem HELLO há 5 s volta ao Wi-Fi.

## Como funciona
1. O servidor procura portas com VID `303A` (Espressif) a cada 3 s, abre a porta (`hupcl: false`, para não reiniciar a placa), manda **PROBE** e espera o **BEACON** (2,5 s). Quem não responde (outra placa ESP32) é ignorado por 60 s.
2. Com a placa confirmada, manda HELLO a cada segundo. A placa passa a usar o cabo (`usbActive()`), consulta `/api/deck` a cada 0,6 s (no Wi-Fi: 1,5 s) e mostra "Mac conectado (USB)".
3. REQ/RES são sequenciais (um pedido por vez); o RES de imagens/animações é enviado em pedaços de 1 KB com 1 ms de intervalo, porque a fila de RX da USB da placa (16 KB) descarta bytes se encher.
4. `board_ip` em `/api/status` vira `USB` (cabeçalho `X-Deck-Via: usb` do pedido repetido).

## Firmware
- **Uma task só (Core 0, `usbrx`) lê a serial** (`Serial.setRxBufferSize(16384)`): separa quadros de texto; os comandos de depuração (`T x,y`, `P`, `S`, `H`, `K`, `W`) chegam ao `loop()` por `usbCmd()`.
- `usbRequest()` envia o REQ com **um único** `Serial.write` (o HWCDC segura um mutex: não se mistura com logs de outras tasks) e espera o RES; o timeout vale para a *ausência de bytes*.
- Imagens vão direto para o buffer de destino (sem cópia); `/api/deck` vai para um buffer de 24 KB na PSRAM.

## Operação
- `GET /api/status` e `GET /api/usb`: `{enabled, state: off|searching|connected|unavailable, port, board, requests, error}`.
- `POST /api/usb {"enabled": false}`: **solta a porta** (e guarda a preferência em `usb.json`). **Faça isso antes de gravar o firmware com o esptool** e ligue de novo depois (`{"enabled": true}`).
- Instâncias de teste (`DECK_NOMDNS` sem `DECK_USB`, `DECK_DRYRUN` ou `DECK_NOUSB`) **não abrem porta USB**: senão tomariam a placa de verdade. O app do Mac sobe o servidor com `DECK_NOMDNS=1` e por isso passa `DECK_USB=1`.
- Sem o módulo `serialport` (ou sem permissão), o app segue normal pelo Wi-Fi (`state: unavailable`).
- Windows: o driver USB-Serial/JTAG do Windows 10/11 costuma funcionar sozinho; não foi validado em máquina real.
