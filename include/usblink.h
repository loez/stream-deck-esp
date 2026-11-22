// Conexão com o servidor por cabo USB (túnel HTTP sobre a serial USB-Serial/JTAG). Protocolo em docs/PROTOCOLO-USB.md.
// Uma task (Core 0) é a ÚNICA que lê a serial: separa os quadros do servidor dos comandos de texto de depuração (T, P, S...) que o loop() ainda lê por usbCmd().
#pragma once
#include <Arduino.h>

void usbLinkInit();                  // cria a task de leitura (depois de Serial.setRxBufferSize/begin)
bool usbActive();                    // o servidor mandou HELLO nos últimos 5 s (ou está respondendo): o cabo está em uso
Stream &usbCmd();                    // bytes de texto recebidos (fora dos quadros): comandos de depuração
// Pedido HTTP pelo cabo. method: 1 = GET, 2 = POST. Os primeiros hdrLen bytes do corpo vão para hdr, o resto para dst (até cap). Devolve o status HTTP, ou <= 0 se falhou (sem resposta).
// bodyLen = tamanho total do corpo recebido (comparar com o esperado). timeoutMs vale para a ausência de bytes (não para a duração total).
int usbRequest(uint8_t method, const char *path, uint8_t *hdr, size_t hdrLen, uint8_t *dst, size_t cap, size_t *bodyLen, uint32_t timeoutMs);
