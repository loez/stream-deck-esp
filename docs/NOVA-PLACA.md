# Placa maior: o que fazer quando chegar

> Para adaptar o projeto a **qualquer outra placa** (requisitos, passo a passo, modelo de código e problemas comuns), veja `ADAPTAR-PLACA.md`. Este documento é a bateria de testes depois que a placa nova já existe.

**Estado (2026-11-21):** a ideia está preparada, sem hardware novo ainda. Já pronto e testado na ES3C28P:
- O servidor recebe a tela da placa (`/api/deck?w=&h=&ppi=`) e calcula grade, botões e limites pelo **tamanho físico** (botão >= 12 x 7,5 mm; teto do formato 8x6). Grade virtual de 8 colunas, migração de configs antigas.
- O firmware é portável: `include/board.h` (interface) + `src/board_es3c28p.cpp` (a placa atual). Buffers de imagem dinâmicos na PSRAM (teto 6 MB), troca segura entre os núcleos.
- Testes de servidor com tela fictícia 800x480 (`node/test/stride.ts`).

Falta o que só o hardware responde: driver do painel, toque, desempenho real e usabilidade. Este documento é o roteiro para a **bateria de testes** quando a placa chegar.

## 1. O que me passar (antes de eu escrever o `board_<nome>.cpp`)
- Modelo exato / link da página do fabricante (e esquemático ou tabela de pinos, se houver).
- Tela: tamanho em polegadas, resolução, **tipo de interface** (SPI, RGB paralelo, MIPI-DSI), controlador (ILI9488, ST7796, ST7262, NV3041...) e orientação nativa.
- Toque: controlador (GT911, FT5x06, CST816...), barramento (I2C: endereço e pinos), pino de reset/interrupção.
- Chip: ESP32-S3 (esperado) ou outro (**ESP32-P4/MIPI-DSI é bem mais trabalhoso**), flash, PSRAM (quad/octal, 8 MB?).
- Backlight (pino, PWM ou ligado direto), LED, bateria, microSD (só se formos usar).
- Exemplo oficial do fabricante (Arduino/ESP-IDF/LVGL): costuma trazer a sequência de init do painel e os pinos.

## 2. Passos de portagem
1. Criar `src/board_<nome>.cpp` implementando `boardInit`, `boardDisplayInit`, `boardFlushIdle`, `boardTouch`, `boardBacklight` e `BOARD = {nome, w, h, ppi}` (ppi = diagonal em pixels / diagonal em polegadas).
2. Em `platformio.ini`: novo `[env:<nome>]` (placa, PSRAM `memory_type`, flash, `build_src_filter = +<*> -<board_*.cpp> +<board_<nome>.cpp>`).
3. Painel RGB/DSI: frame buffer na PSRAM (+ bounce buffer interno), `LV_DISPLAY_RENDER_MODE_DIRECT/PARTIAL` conforme o driver; checar a taxa de relógio (rasgo/tela torta = temporização).
4. Calibrar o toque (cantos e centro) e a orientação; guardar a calibração no `board_<nome>.cpp`.
5. Conferir `lv_conf.h` (tamanho do heap do LVGL na PSRAM, fontes) e a pilha das tarefas.
6. **Gravação sempre com autorização** (regra do projeto); fazer backup do firmware de fábrica da placa nova antes do primeiro upload.

## 3. Bateria de testes (marque conforme for fazendo)
**Bring-up**
- [ ] Imagem aparece certa (cores, sem inversão, sem espelhamento, orientação paisagem) — ver `P` (captura) na serial.
- [ ] Toque acerta: cantos, centro e bordas dos botões (usar `T x,y` e toque real); sem "fantasma" nem deriva.
- [ ] Backlight: PWM suave e apagar por tempo.
- [ ] Wi-Fi + mDNS: a placa acha o servidor sem mexer em nada.

**Geometria (o servidor decide pela tela informada)**
- [ ] A página mostra "Tela da placa: WxH, ppi" certos; limites coerentes (ex.: 4,3" 800x480 217 ppi: até 7x6).
- [ ] Para cada grade (2x2, 4x2, 4x4, 6x4, máximo): botões sem sobreposição, margens iguais, faixa do nome legível, fonte escolhida respeitada.
- [ ] Sem faixa de status: botões sobem e ocupam o topo.
- [ ] Trocar a grade ao vivo não trava e não deixa imagem velha (`[grade]` na serial; sem `sem memoria`).
- [ ] Trocar de placa (ES3C28P <-> nova) com a mesma configuração: grade ajustada ao que cabe, escolha salva preservada.

**Usabilidade física (o ponto mais importante)**
- [ ] Acerto do toque com o dedo em cada tamanho de botão; o limite de 12 x 7,5 mm está bom ou precisa subir/descer? (ajustar `MIN_BTN_MM` em `node/src/settings.ts`).
- [ ] Legibilidade das fontes (10 a 24 px) à distância de uso; ajustar a faixa de fontes por densidade (`limitsFor`).
- [ ] Ícones/imagens: nitidez e tamanho do ícone (44/56 px) proporcional ao botão (`renderButton`); talvez escalar pela densidade.

**Desempenho (medir e anotar)**
- [ ] Tempo para trocar de página com N botões (hoje 1 requisição HTTP por imagem). Meta: < 1,5 s com 35 botões. Se passar: enviar imagens em lote (um `/api/imgs` com todas), comprimir (PNG/JPEG decodificado na placa) ou só mandar o que mudou.
- [ ] Latência do toque até o efeito (sem lag perceptível).
- [ ] Memória: `[heap] interna/psram` após trocar de grade várias vezes; sem vazamento (rodar o teste de trocar grade 20x).
- [ ] Wi-Fi estável por horas (consulta a cada 1,5 s; avaliar push em vez de polling).
- [ ] Temperatura/consumo se alimentada pela USB do Mac.

**Animação e botões juntados (novo)**
- [x] ES3C28P: 4 GIFs juntos, GIF em botão 2x1 e 20 trocas de página sem vazamento (números no README). Falta: GIF em 2x2/tela cheia e ajuste fino de `BOARD.fill`/`ANIM_BUDGET` por fps medido; repetir na placa maior.
- [ ] Telas maiores: GIF de tela cheia no máximo de botões (preenchimento RGB paralelo vs SPI).

**Regressão**
- [ ] `cd node && npm test` (inclui `stride.ts`).
- [ ] A ES3C28P continua igual com o firmware novo (compilar o env dela).
- [ ] Plugins instalados mostram ícone/texto certos nos botões maiores.

## 4. Critérios de aceite
- Grade máxima da tela funciona sem lentidão perceptível e sem erro de memória.
- Toque confiável em todos os tamanhos permitidos pelo limite físico.
- Trocar entre as duas placas não exige mexer na configuração.
- `board_<nome>.cpp` documentado (pinos, calibração, observações do painel) para outras pessoas reproduzirem.

## 5. Opcional depois
- **Várias placas ao mesmo tempo** (perfil por placa: página atual, grade e configurações separadas): ~2 dias.
- Imagens em lote / compressão (se o item de desempenho falhar).
- Orientação retrato; tela sem toque (só mostrar + botões físicos).
