# Adaptar o Stream Deck para a sua placa ESP32 com tela de toque

*[English](en/ADAPT-BOARD.md)*

Este guia é para quem tem **outra placa** (ou quer usar outra tela) e quer rodar o nosso Stream Deck nela. Serve para fazer sozinho ou para entregar a um assistente de IA (como o Claude) junto com os dados da placa.
Para a bateria de testes de uma placa nova, veja também `NOVA-PLACA.md`.

## 1. Sua placa serve?

O firmware (`src/main.cpp`) é o mesmo para todas as placas. O que muda de uma para outra é **um arquivo**: `src/board_<nome>.cpp` (pinos, tela, toque, luz de fundo). O servidor, o app, os plugins e a configuração dos botões **não mudam**: a placa informa o tamanho da tela e o servidor calcula a grade sozinho.

| Requisito | Precisa | Observação |
|---|---|---|
| Chip | **ESP32-S3** (recomendado) | ESP32-S2 só com muito jeito; **ESP32-P4** (tela MIPI-DSI) é bem mais trabalhoso; ESP32 clássico e C3 **não servem** (sem PSRAM / pouca RAM) |
| PSRAM | **Sim, 8 MB ideal** (mínimo 2 MB) | As imagens dos botões, o LVGL e o TLS ficam nela. Sem PSRAM não cabe |
| Flash | 4 MB serve; 8 ou 16 MB é melhor | Ver "Partições" no passo 3 |
| Tela | Qualquer uma que o ESP32 consiga acionar | SPI (ILI9341, ST7789, ST7796, ILI9488…) é o caso fácil; RGB paralela é possível; MIPI-DSI é difícil |
| Toque | **Obrigatório** (capacitivo ou resistivo) | FT6336/FT5x06, GT911, CST816, CST328, XPT2046… |
| Wi-Fi | O do próprio ESP32 | A placa acha o servidor sozinha na rede (mDNS) |
| Tamanho físico | Botões de pelo menos 12 x 7,5 mm | Telas muito pequenas (< 2") ficam com poucos botões |
| Cabo USB | USB nativa do S3 (porta "USB" / "JTAG") | A conexão por cabo (túnel pela serial) só existe com USB nativa; sem ela vale só o Wi-Fi |

Se a sua placa cumpre isso, o trabalho é escrever o arquivo da placa e acertar três coisas: **imagem, toque e memória**.

## 2. O que reunir antes de começar
1. **Modelo exato** e a página do fabricante (esquemático/tabela de pinos e, de preferência, o **exemplo oficial** Arduino/ESP-IDF/LVGL: ele traz a sequência de inicialização da tela e os pinos certos).
2. **Chip, flash e PSRAM** (ex.: ESP32-S3, 16 MB, 8 MB octal). Está impresso no chip ou na ficha da placa.
3. **Tela:** polegadas, resolução, controlador e interface (SPI / RGB / DSI), orientação natural, se precisa de **inversão de cor**.
4. **Toque:** controlador, endereço I²C ou pinos SPI, pinos de reset e de interrupção.
5. **Luz de fundo:** pino e se é PWM ou fixa. **Extras** que atrapalham se ficarem ligados: amplificador de áudio, LED, bateria.
6. Uma **cópia do firmware de fábrica** (passo 4) antes da primeira gravação.

## 3. Passo a passo

### Passo 1 — Preparar o ambiente
Precisa de Python 3 e do PlatformIO. O projeto usa o núcleo Arduino 3.x (pioarduino, já configurado no `platformio.ini`).
```bash
python3 -m pip install --user platformio esptool      # ou: pipx install platformio
pio run                                                # compila o env padrão (es3c28p) a partir da raiz do repositório
```
Confirme que a placa atual compila antes de mexer em qualquer coisa. (`pio run -e minha_placa` compila um env específico.)

### Passo 2 — Descobrir a porta e o chip
```bash
ls /dev/cu.usbmodem*                       # macOS; Linux: /dev/ttyACM0; Windows: COMx
esptool.py --port <porta> chip_id
esptool.py --port <porta> flash_id         # mostra o tamanho da flash
```
O número da porta **muda quando replugar o cabo**. `No serial data received` costuma ser só replugar (ou segurar BOOT ao ligar).

### Passo 3 — Criar o ambiente no `platformio.ini`
Copie o bloco `[env:es3c28p]` e ajuste. O que depende da sua placa:

```ini
[env:minha_placa]
build_src_filter = +<*> -<board_*.cpp> +<board_minha_placa.cpp>
platform = https://github.com/pioarduino/platform-espressif32/releases/download/stable/platform-espressif32.zip
board = esp32-s3-devkitc-1
framework = arduino
board_build.flash_size = 16MB                 ; o que o flash_id mostrou
board_build.partitions = default_16MB.csv     ; 8 MB: default_8MB.csv · 4 MB: huge_app.csv (o app tem ~2 MB)
board_build.arduino.memory_type = dio_opi     ; PSRAM OCTAL (a maioria dos S3 N16R8). PSRAM QUAD (R2/R4): qio_qspi
board_upload.flash_size = 16MB
; ... mantenha lib_deps e build_flags iguais às da es3c28p
```
Pontos que mais dão problema:
- **`memory_type` errado** (octal x quad) = a placa reinicia em loop ou não acha a PSRAM. Se der "PSRAM ID read error", troque.
- **Partições:** o firmware tem ~2 MB; o `default.csv` (4 MB) tem só 1,25 MB de app e **não cabe**: use `huge_app.csv`.
- `-DARDUINO_USB_CDC_ON_BOOT=1` pressupõe USB nativa; em placas com ponte USB-serial externa, tire e use a serial normal.

### Passo 4 — Backup do firmware de fábrica
```bash
esptool.py --port <porta> read_flash 0 0x1000000 backup_fabrica.bin   # 0x1000000 = 16 MB; ajuste ao tamanho da flash
```
Guarde **fora do repositório** (já está no `.gitignore`: `backup/` e `*.bin`). **Não versione** backup de flash (pode conter senhas de Wi-Fi). Sem isso você não volta ao firmware original.

### Passo 5 — Escrever `src/board_<nome>.cpp`
A interface é `include/board.h`. São 6 funções e uma constante:

| Função | O que faz |
|---|---|
| `const BoardInfo BOARD` | `{nome, largura, altura, ppi, fill}` em **paisagem** (veja "Contas" abaixo) |
| `boardInit()` | Pinos de energia, I²C, reset do toque, luz de fundo **apagada**. Desligue o que não usa (ex.: amplificador de áudio) |
| `boardDisplayInit(disp)` | Barramento + painel + **buffers do LVGL** + callback de envio (`flush`) |
| `boardFlushIdle()` | `true` quando o último envio à tela terminou |
| `boardTouch(&x,&y)` | `true` se há toque; x,y já na orientação da tela (0..w-1, 0..h-1) |
| `boardBacklight(0..255)` | Brilho |
| `boardPowerOff()` | Apaga tudo antes do deep sleep |

**Modelo mínimo** (tela SPI com envio simples e toque I²C; o que está em `<...>` é da sua placa). A versão completa e assíncrona (DMA) está em `src/board_es3c28p.cpp`, use-a de referência:

```cpp
#include "board.h"
#include <Wire.h>
// <inclua aqui o driver da sua tela: esp_lcd, LovyanGFX, TFT_eSPI, Arduino_GFX ou o do fabricante>

#define PIN_BL <pino>
#define PIN_I2C_SDA <pino>
#define PIN_I2C_SCL <pino>
#define PIN_TOUCH_RST <pino>
const BoardInfo BOARD = {"MinhaPlaca", <largura>, <altura>, <ppi>, <fill>};

static void flush_cb(lv_display_t *disp, const lv_area_t *a, uint8_t *px) {
  const uint32_t w = a->x2 - a->x1 + 1, h = a->y2 - a->y1 + 1;
  // SPI costuma querer os bytes do RGB565 trocados:
  lv_draw_sw_rgb565_swap(px, w * h);
  // <envie os pixels para a janela (x1,y1)-(x2,y2) com o driver da tela>
  lv_display_flush_ready(disp);   // se o envio for síncrono, avise aqui; se for por DMA, avise na interrupção de "terminou"
}

void boardInit() {
  pinMode(PIN_BL, OUTPUT); analogWrite(PIN_BL, 0);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  pinMode(PIN_TOUCH_RST, OUTPUT); digitalWrite(PIN_TOUCH_RST, LOW); delay(10); digitalWrite(PIN_TOUCH_RST, HIGH); delay(100);
}
void boardDisplayInit(lv_display_t *disp) {
  // <inicialize o barramento e o painel (sequência do exemplo do fabricante)>
  lv_display_set_flush_cb(disp, flush_cb);
  const size_t BUF = BOARD.w * 24 * 2;   // 24 linhas de RGB565; buffer duplo
  void *b1 = heap_caps_malloc(BUF, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL), *b2 = heap_caps_malloc(BUF, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  lv_display_set_buffers(disp, b1, b2, BUF, LV_DISPLAY_RENDER_MODE_PARTIAL);
}
bool boardFlushIdle() { return true; }          // envio síncrono: sempre livre
void boardBacklight(int v) { analogWrite(PIN_BL, v); }
void boardPowerOff() { analogWrite(PIN_BL, 0); /* <painel em sleep> */ }
bool boardTouch(int *x, int *y) { /* <leia o controlador; converta para a orientação da tela; devolva false se não há toque> */ return false; }
```
Painéis **RGB paralelos** (sem comandos SPI) usam `esp_lcd_rgb_panel` com o quadro na PSRAM (e um *bounce buffer* interno); aí o `flush` não troca bytes e o modo costuma ser `LV_DISPLAY_RENDER_MODE_DIRECT`. É o caso mais trabalhoso: peça o exemplo oficial.

**Contas do `BOARD`:**
- `ppi = √(largura² + altura²) / diagonal em polegadas`. Ex.: 320x240 em 2,8" → 400 / 2,8 ≈ **143**. É o que define o tamanho físico mínimo dos botões.
- `fill` = pixels por segundo que a tela aguenta redesenhar (limita os GIFs). SPI a 40 MHz ≈ 1,7 Mpx/s no total; use ~1.000.000. Em RGB paralelo é bem maior (ordem de 10x). Se não souber, comece com 1000000.

### Passo 6 — Primeiro boot: imagem
Grave (veja "Gravar com segurança") e abra o monitor serial (`pio device monitor`, 115200). Confira:

| Sintoma | Causa provável | Correção |
|---|---|---|
| Tela branca/preta, nada | Sequência de init errada, backlight, pino de reset | Compare com o exemplo do fabricante; teste o backlight a 255 |
| Cores trocadas (vermelho↔azul) | Ordem RGB/BGR | Bit BGR no registrador MADCTL (`0x36`) do painel |
| Cores "negativas" | Falta inversão | Comando `0x21` (INVON) – alguns painéis exigem (a ES3C28P exige) |
| Imagem espelhada ou girada | Orientação | MADCTL `0x36` (bits MX/MY/MV) para paisagem |
| Imagem torta/rasgada | Relógio alto demais (SPI) ou temporização RGB | Baixe o clock (a ES3C28P corrompe a 80 MHz; usa 40) |
| Cores estranhas só em texto | Troca de bytes | Retire/inclua `lv_draw_sw_rgb565_swap` |
| Reinicia em loop | `memory_type` da PSRAM | Passo 3 |

A serial do firmware aceita um comando `P` que captura a tela para conferir sem foto (ver `NOVA-PLACA.md`).

### Passo 7 — Toque
1. Leia o controlador cru e imprima x,y ao tocar nos **quatro cantos e no centro**.
2. Converta para a orientação da tela. Os controladores costumam vir trocados (x↔y) ou invertidos. A ES3C28P, por exemplo, usa `x = y_cru` e `y = 240 − x_cru`, com uma pequena escala medida (veja o final de `board_es3c28p.cpp`).
3. Anote as fórmulas no próprio arquivo da placa. O toque tem que acertar os botões das bordas, sem "fantasmas".
4. Se a placa tem **pino de interrupção** do toque, não é obrigatório: a leitura por polling basta.

### Passo 8 — Wi-Fi, pareamento e servidor
Não muda nada: com a placa ligada na mesma rede do computador, ela acha o app (mDNS). Pareie na página de configuração ("Parear placa"). Para o Wi-Fi novo, a placa abre o portal próprio (ou envie `W` pela serial). O servidor mostra "Tela da placa: LxA, ppi" e calcula os limites da grade.

### Passo 9 — Memória
O gargalo é a **RAM interna** (o Wi-Fi/TLS usa muito). Cuidados:
- Buffers do LVGL **pequenos** e internos com DMA (24 linhas bastam); o quadro grande vai para a PSRAM.
- Veja `[heap] interna … psram …` na serial depois de trocar a grade várias vezes: não pode cair a cada troca (vazamento).
- Telas maiores gastam mais imagem na PSRAM (teto do projeto: 6 MB). Leia `docs/hardware/MEMORIA-RAM.md` e `docs/hardware/MULTICORE.md` (Core 0 = rede; Core 1 = tela/toque).

### Passo 10 — Ajustes finos no servidor (opcional)
Em `node/src/settings.ts`: `MIN_BTN_MM` (tamanho mínimo de botão para o dedo acertar), `limitsFor` (faixa de fontes e de colunas/linhas por densidade). Se a sua tela tem dedo "grosso" no uso, aumente o mínimo.

### Passo 11 — Gravar com segurança
- Grave só depois do backup (passo 4).
- Se o app estiver rodando com a conexão por cabo, solte a porta antes: `curl -XPOST localhost:8765/api/usb -d '{"enabled":false}'`, grave, e religue com `true`.
- `pio run -t upload --upload-port <porta>` (ou `esptool.py write_flash`).
- Se não houver resposta da placa, **replugue o cabo** (não é placa morta).
- **Voltar ao original:** `esptool.py --port <porta> write_flash 0 backup_fabrica.bin`.

### Passo 12 — Validar
- Roda `cd node && npm test` (inclui os testes de grade com tela fictícia).
- Faça a bateria de `NOVA-PLACA.md`: imagem, toque, grade (2x2 até o máximo), trocar de página, GIF, memória, Wi-Fi por horas.
- Confirme que a **ES3C28P continua igual** (compile o env dela).
- Documente a sua placa: pinos, calibração e manhas do painel em `docs/hardware/<PLACA>.md` (veja `docs/hardware/ES3C28P.md` como exemplo) e abra um pull request.

## 4. Peça ajuda (o que enviar)
Cole isto preenchido, numa issue ou para um assistente de IA, e peça o `board_<nome>.cpp` e o `[env:…]`:
```
Placa: <modelo + link>
Chip/flash/PSRAM: <ex.: ESP32-S3, 16 MB, 8 MB octal>
Tela: <polegadas, resolução, controlador, interface SPI/RGB/DSI, pinos>
Toque: <controlador, I2C (SDA/SCL/endereço) ou SPI, pinos de reset/INT>
Backlight: <pino, PWM?>   Extras a manter desligados: <amplificador, LED...>
Exemplo oficial do fabricante: <link ou arquivo>
```
Quem ajudar precisa da placa **ligada no computador** para gravar e ver os resultados (e vai pedir que você replugue o cabo e confirme o que vê na tela).

## 5. Limites conhecidos
- **Sem toque:** não é suportado hoje (a interface é a tela de toque).
- **Orientação retrato** e **várias placas ao mesmo tempo:** ainda não.
- **MIPI-DSI (ESP32-P4):** exige outro driver e, provavelmente, outra versão do núcleo; tratado como projeto à parte.
- Tela monocromática (e-paper, OLED 1 bit) não é adequada: o servidor entrega imagens coloridas.
