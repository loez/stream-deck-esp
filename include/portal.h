// Portal de configuração do Wi-Fi (primeira vez / rede nova): a placa cria uma rede temporária (StreamDeck-XXXX, senha aleatória mostrada na tela e no QR code),
// o celular abre a página, vê a LISTA das redes que a placa enxerga e só precisa tocar numa e digitar a senha. A rede fica gravada na NVS (WiFi.begin).
// Tudo roda no Core 0 (netTask); o Core 1 só lê portalView() para desenhar a tela de instruções.
#pragma once
#include <Arduino.h>

struct PortalView {
  bool on;           // portal ligado (tela de instruções visível)
  char ssid[24];     // rede temporária da placa
  char pass[12];     // senha dela (aleatória a cada vez)
  char msg[72];      // situação ("Conectando...", "Nao conectou: confira a senha"...)
  uint32_t rev;      // muda a cada alteração
};

void portalTick(bool wifiUp, bool everUp);   // Core 0: chamar a cada volta do loop de rede (abre sozinho se nunca conectou em ~20 s)
bool portalActive();                          // Core 0
void portalForce();                           // qualquer núcleo: abre o portal agora (serial: W), mesmo com Wi-Fi funcionando
void portalDismiss();                         // qualquer núcleo: fecha o portal (botão "Fechar" da tela)
bool portalView(PortalView *v);               // Core 1: copia o estado se mudou desde v->rev (true = mudou)
