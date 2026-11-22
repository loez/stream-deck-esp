// Interface entre o firmware (src/main.cpp, igual para todas as placas) e cada placa (src/board_<nome>.cpp: pinos, driver do painel, toque, backlight).
// Para uma placa nova: criar src/board_<nome>.cpp implementando estas funções, um [env:<nome>] no platformio.ini apontando para ele e pronto.
// O firmware informa o tamanho/densidade da tela ao servidor (/api/deck?w=&h=&ppi=) e o servidor calcula a grade, o tamanho dos botões e quantos cabem.
#pragma once
#include <Arduino.h>
#include <lvgl.h>

struct BoardInfo {
  const char *name;   // nome da placa (log)
  int w, h;           // pixels da tela, na orientação de uso (paisagem)
  int ppi;            // pixels por polegada (diagonal em pixels / diagonal em polegadas): define o tamanho FÍSICO mínimo dos botões
  int fill;           // pixels por segundo que a tela aguenta redesenhar em animações (barramento do painel menos o que a interface já usa): o servidor limita fps/área dos GIFs por isso
};
extern const BoardInfo BOARD;

void boardInit();                            // pinos de energia/áudio, I2C, reset do toque, backlight apagado (chamado antes de tudo)
void boardDisplayInit(lv_display_t *disp);   // barramento + painel + buffers + callbacks de flush do LVGL (o display já foi criado com BOARD.w x BOARD.h)
bool boardFlushIdle();                       // true quando o último envio ao painel terminou
bool boardTouch(int *x, int *y);             // true se há toque; x,y na orientação da tela (0..w-1, 0..h-1)
void boardBacklight(int v);                  // 0..255
void boardPowerOff();                        // prepara o desligamento total (painel em sleep, backlight apagado e travado); o main.cpp entra em deep sleep em seguida. Só o botão RESET (EN) acorda
