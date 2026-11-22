# Modo autônomo da placa (sem o app/PC)

Quando o app (ou o computador) some, a placa **assume sozinha** um modo autônomo via Wi-Fi: **relógio de mesa** (hora grande, data e clima) e, ao tocar, uma **grade de botões de casa inteligente** que ela mesma executa (webhook HTTP/HTTPS, Home Assistant, MQTT).
Quando o servidor volta (Wi-Fi ou cabo USB), ela retorna ao modo normal sozinha.

## Como usar
1. **Botões de casa inteligente** (biblioteca de ações, grupo **Casa inteligente**): *Webhook*, *Home Assistant* (com "Carregar entidades"), *MQTT (publicar)*, *Relógio* e *Clima*. Funcionam também no modo normal (o servidor executa/desenha) e têm o botão **Testar**.
2. **Configurações > Modo autônomo:** ligue, escolha a **página** que a placa leva, o fuso horário (vazio = o do computador), a **cidade** do clima, 24 h, quanto tempo sem toque volta ao relógio e o **escurecer à noite**. A lista mostra, para cada botão da página, se **funciona sem o PC** (webhook, Home Assistant, MQTT, relógio, clima) ou **precisa do computador** (abrir app, atalho, plugin...; esses piscam vermelho no modo autônomo).
3. Com a placa conectada, o app envia o perfil (a tela mostra "Perfil enviado à placa ✓"). Daí em diante, **fechar o app** faz a placa mostrar o relógio em ~12 s.

## Quando a placa entra e sai do modo autônomo
- **Entra** só quando **não há servidor de verdade**: sem cabo USB **e** sem nenhuma resposta HTTP há 8 s (uma resposta com erro, ou lenta, conta como servidor presente), por mais 4 s, depois dos primeiros 20 s de boot (o Wi-Fi e a busca do servidor ainda acontecem) **e** com um perfil guardado. Assim ela nunca disputa com um servidor que está lá. Funciona também sem Wi-Fi (a hora segue pelo relógio interno desde o último acerto).
- **Sai** quando o cabo USB reaparece, ou quando o servidor responde (a placa procura por mDNS a cada 5 s). A grade do servidor é baixada de novo por inteiro.
- Tela: relógio em tela cheia; **tocar** mostra a grade do perfil; **sem toque** por `idleReturnS` volta ao relógio. À noite (se ligado) o brilho cai para a % escolhida depois de 30 s sem toque; qualquer toque acende.
- Barra de status: "Modo autonomo" (ponto azul).

## Arquitetura
```
servidor (sempre que conectado)               placa (flash: LittleFS na partição "spiffs")
  standalone.json (config)  ─┐                  /sa/profile.json   ← commit por último (profile.new → rename)
  sa-profile.ts: buildProfile ├─ GET /api/sa ──▶ /sa/img/<i>.raw    imagem RGB565 de cada botão
  netactions.ts (executores)  │  /api/sa/img/…   /sa/icon/<tipo>.raw 8 ícones do clima 48x48
  /api/deck: sa=<rev>, t=<epoch> ◀── &sa=<rev>   (a placa informa a revisão que tem)
```
- **`/api/deck`** ganhou `sa` (revisão do perfil; `"0"` = desligado/sem perfil → a placa apaga) e `t` (epoch do servidor, para acertar a hora sem internet). Segredos **nunca** vão em `/api/deck`.
- **`GET /api/sa`** (token da placa ou cabo): perfil JSON com `ex` (descritor de execução, **com tokens/senhas**) só nos botões que a placa executa; `wd` (`clock`/`weather`) nos que ela desenha; `tz` (POSIX TZ, ex.: `<-03>3`), `weather`, `clock`, `idle`, `night`, `geom`, `tiles`, `tx` (textos já no idioma do app). `GET /api/sa/img/<i>.raw` e `GET /api/sa/icon/<tipo>.raw`.
- **Revisão** = hash do perfil (inclui `imgrev` de cada botão): mudar um botão ou uma opção muda a revisão e a placa baixa de novo (no máximo a cada 30 s se falhar).
- **Fuso:** tabela IANA→POSIX TZ em `node/src/sa-profile.ts` (103 fusos, conferida contra o `Intl` no teste); fora da tabela vira o deslocamento de agora (sem horário de verão).
- **Hora:** NTP (`configTzTime`, `pool.ntp.org`/`time.google.com`) quando há Wi-Fi; sem internet, o relógio do servidor (`t`) acerta a placa a cada consulta. Sem nenhum dos dois: `--:--`.
- **Cidade pelo IP:** enquanto nenhuma cidade foi escolhida, o servidor descobre uma cidade **aproximada pelo IP público** (`ipwho.is`, HTTPS, sem chave; `locateByIp` em `weather.ts`) e a usa no clima (marcada "detectada pelo IP"). **Privacidade:** o serviço enxerga o seu IP público (inevitável nesse método) e mais nada; as coordenadas são arredondadas a 3 casas. A detecção é feita **no servidor**, nunca na placa. Escolher ou apagar a cidade à mão desliga a detecção automática (`locAuto`); o botão **Usar minha localização (pelo IP)** força de novo. Em caso de falha tenta a cada 10 min. `DECK_NOIPGEO=1` desliga tudo; `DECK_IPGEO` aponta para outro serviço (testes). O IP costuma apontar para o provedor, então a cidade pode errar por perto: confira.
- **Clima:** Open-Meteo por **HTTP puro** a cada 20 min (1 min até a 1ª leitura): `current=temperature_2m,weather_code,is_day`; o código WMO vira um de 8 ícones (mesmo mapa em `weather.ts` e `standalone.cpp`).
- **No modo normal** os botões Relógio/Clima são **imagens desenhadas pelo servidor** (atualizadas a cada 15 s); só no modo autônomo a placa os desenha ao vivo.

## Ações executadas pela placa (`src/netexec.cpp`)
Numa task própria (pilha de 16 KB na PSRAM), uma por vez; o resultado vira a borda verde/vermelha do botão.
- **Webhook:** método, corpo, tipo do conteúdo e cabeçalhos (`Nome: valor` por linha); segue redirecionamentos; sucesso = HTTP 2xx. HTTPS ok.
- **Home Assistant:** `POST {url}/api/services/{domínio}/{serviço}` com `Authorization: Bearer <token>` e corpo `{entity_id, ...dados}`.
- **MQTT:** CONNECT/PUBLISH (QoS 0)/DISCONNECT à mão (MQTT 3.1.1), usuário/senha opcionais, TLS opcional, `retain`.
- **TLS:** as alocações do mbedtls vão para a **PSRAM** (`-Wl,--wrap=esp_mbedtls_mem_calloc` em `platformio.ini` + `__wrap_esp_mbedtls_mem_calloc` em `main.cpp`, copiado do `radio-web`). Domínio público: valida **cadeia e nome** com o bundle de raízes do framework; **IP ou `*.local`**: não valida (servidor local autoassinado). **Limitação conhecida** (mbedtls do pioarduino sem `CONFIG_MBEDTLS_HAVE_TIME_DATE`): a **data de validade** do certificado não é conferida.

## Segredos
Tokens do Home Assistant e usuário/senha do MQTT ficam **na flash da placa** (`/sa/profile.json`, em claro) enquanto o modo autônomo estiver ligado. Um backup completo da flash passa a conter esses segredos (como já contém a senha do Wi-Fi): **não compartilhe nem commite backups**.
Não vão para logs. Para apagar: desligue o modo autônomo no app (a placa apaga ao próximo contato) ou envie `X` pela serial.

## Bancada e testes
- `python3 tools/mock_services.py`: webhook/Home Assistant/MQTT simulados que imprimem cada pedido (token do HA de teste: `teste-1234`); serve para provar que **a placa** (e não o servidor) executou com o app fechado. O `ha-painel/tools/mock_ha.py` também serve para o HA.
- Node: `npm run test:netactions` (25), `test:widgets` (18), `test:standalone` (26), `test:i18n`; entram em `npm test`/`test:ci`.
- Firmware: compila com `pio run -e es3c28p`. Validação na placa: seção abaixo.

## Roteiro de validação na placa (só com autorização para gravar; soltar a porta USB antes: `POST /api/usb {"enabled":false}`)
1. Grave o firmware, religue o USB, configure o modo autônomo (página + cidade) e espere "Perfil enviado à placa ✓".
2. Feche o app: em ≈12 s aparece o relógio com hora, data e clima ("Modo autonomo" na barra ao tocar).
3. Rode `tools/mock_services.py`, toque num botão Webhook/HA/MQTT: aparece a linha no terminal e o botão pisca verde. Botão "Safari": pisca vermelho.
4. Reabra o app (ou o cabo): a placa volta ao modo normal sozinha.
5. Deixe 30 min com HTTPS em uso: o log `[dbg]` deve mostrar a RAM interna estável (meta ≥ 60 KB livres).

## Validado na placa real (2026-11-22)
Com o app fechado: o relógio aparece sozinho em ≈20-30 s após o boot (≈12 s depois de o servidor sumir com a placa já ligada); tocar mostra a grade; **webhook** (POST com corpo e cabeçalho), **Home Assistant** (Bearer) e **MQTT** foram executados **pela placa** (conferido nos logs do `mock_services.py`); botão do tipo "abrir app" pisca vermelho; **HTTPS** (`https://example.com`) devolve 200 com validação de cadeia e nome, 3 toques seguidos sem vazamento (RAM interna estável em 63-64 KB, PSRAM estável).
Ao reabrir o app a placa voltou ao modo normal sozinha, **pelo cabo e pelo Wi-Fi/mDNS** (≤ 15 s). RAM interna: 115 KB antes de entrar; ≈64 KB no modo autônomo (os 16 botões da grade 4x4 em objetos LVGL custam ~48 KB: é o mesmo custo da grade 4x4 normal).

## Lições (bugs encontrados na validação)
- **Resposta em pedaços (chunked):** o Open-Meteo responde com `Transfer-Encoding: chunked` e `http.getStream()` do HTTPClient é a conexão crua: o JSON não parseava. Use `useHTTP10(true)` (ou `getString()`).
- **ArduinoJson 7:** numa variante **const** (`JsonObjectConst`/`JsonVariantConst`) `is<JsonObject>()` é sempre falso; use `isNull()` ou `is<JsonObjectConst>()`.
- **Serial:** `pyserial` reinicia a placa a cada `open()` (USB-Serial/JTAG); use `tools/serial-sem-reiniciar.mjs` (Node `serialport` com `hupcl:false`) para observar. O snapshot (`P`) agora captura o relógio do modo autônomo quando ele está visível.

## Arquivos
`node/src/netactions.ts`, `widgets.ts`, `weather.ts`, `standalone.ts`, `sa-profile.ts` · firmware: `include/standalone.h`, `src/standalone.cpp`, `src/netexec.cpp`, e a máquina de modos/relógio em `src/main.cpp` (`saEnter/saLeave/saApplyGrid/saPress/saSync`, `saUiTick`).
