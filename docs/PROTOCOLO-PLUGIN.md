# Protocolo de plugins do Stream Deck ESP (v2) e SDK

*[English](en/PLUGIN-PROTOCOL.md)*

Este documento define **o que um plugin pode fazer** e como ele fala com o app. O **SDK** (`sdk/deck-plugin.mjs`, para o serviço do plugin, e `/deck-ui.js`, para a tela de configuração) é a forma de escrever plugins;
o protocolo abaixo é o que ele fala com o host (o servidor, `node/src/plugins.ts`, codificação em `node/src/plugin-protocol.ts`). Formato da pasta, manifesto, instalação (URL do GitHub, .zip), hot-reload, HTTP local e receitas: `CRIAR-PLUGIN.md`.

> **Independência.** Nada do projeto depende do SDK ou do protocolo do Ulanzi Studio. O host só conhece eventos internos; a língua nossa (esta, v2) e a **legada do Ulanzi** viram os mesmos eventos.
> A língua legada continua aceita **só para importar e rodar plugins feitos para o Ulanzi Studio** (seção 7).

## 1. Conceitos
- **Plugin**: pasta `*.deckplugin` com `plugin.json` e um serviço Node (`main`). O host o inicia quando algum botão usa uma ação dele e o reinicia se cair.
- **Ação**: o que um botão faz (declarada em `actions` do `plugin.json`). **Botão**: uma atribuição de ação a uma posição; identificado pelo **`id`** (o id da atribuição, um UUID que o host guarda em `config.json` junto com as configurações). `key` = `coluna_linha`.
- **Configuração do botão** (`settings`): JSON salvo pelo host por botão. **Configuração global**: JSON por plugin. Segredos: arquivo `config.json` na pasta do plugin (0600, nunca servido).
- **Tela de configuração (UI)**: HTML opcional por ação (`ui` no `plugin.json`), aberto num iframe da página do app.

## 2. SDK do serviço (`sdk/deck-plugin.mjs`)
Copie o arquivo para dentro do plugin (o app não roda `npm install`). Zero dependências.

```js
import { Plugin } from './deck-plugin.mjs';
const plugin = new Plugin();            // endereço/porta: argumentos do processo; id: plugin.json da pasta atual
plugin.action('contador', {             // nome curto (o que vem depois do último ponto do id da ação) ou o id completo
  onAdd:      (b) => {},                // botão apareceu (b.settings = configuração salva)
  onRemove:   (b) => {},
  onPress:    (b) => {},                // toque; onDown/onUp = pressionar/soltar
  onSettings: (b, settings) => {},      // a configuração do botão mudou
  onActive:   (b, ativo) => {},         // a página do botão entrou/saiu da placa (pause trabalho caro quando false)
  onMessage:  (b, payload) => {},       // mensagem da tela de configuração
});
```
Tratadores podem ser `async`; erro dentro deles vai para o log do plugin e **não derruba** o serviço.

| Objeto | Membro | O que faz |
|---|---|---|
| `Button` | `id`, `action`, `key`, `settings`, `state`, `active` | `state` é área livre sua (não persiste) |
| | `set({ image, imageFile, gif, gifFile, text })` | muda ícone/texto; o que você não passa continua como estava |
| | `toast(msg)` · `alert()` | aviso curto (resultado do toque) · marca o botão como falho |
| | `save(settings)` | grava a configuração do botão (persiste; chama `onSettings` aqui e na tela) |
| | `sendToUI(payload)` | manda uma mensagem à tela de configuração aberta deste botão |
| `Plugin` | `list([ação])` | botões ativos (opcionalmente só de uma ação) |
| | `getGlobal()` → Promise · `setGlobal(obj)` | configuração global do plugin |
| | `openUrl(url[, params])` · `hotkey('cmd+shift+4')` | abrir endereço http/https · atalho (`cmd` vira Ctrl fora do Mac) |
| | `language` · `log(msg, nível)` · `ready` · `onClose` | idioma do app (`'pt-BR'` ou `'en'`, vem em `argv[4]`) · log do plugin · promessa da conexão · o padrão é sair junto com o host |

`image` aceita data URI (PNG/JPG/GIF/SVG) ou `Buffer` PNG; `gif` aceita base64 ou `Buffer` (anima o botão); `*File` são caminhos dentro da pasta do plugin. Ícone quadrado, 144x144 por padrão.
`text` (com `\n`) é desenhado **pelo host** por cima do ícone, só se o usuário marcou "mostrar texto do plugin" no botão. Reenviar o mesmo ícone não custa nada; não mande `set` em alta frequência.

## 3. SDK da tela de configuração (`/deck-ui.js`)
O app serve este script; a página do plugin só inclui. Ela recebe na URL `port`, `address`, `id`, `plugin`, `action`, `key`, `language`.
```html
<script src="/deck-ui.js"></script>
<script>
  const ui = new DeckUI();
  ui.onSettings((s) => { /* preencha o formulário com a configuração do botão (agora e quando mudar) */ });
  ui.onMessage((payload) => { /* mensagem do serviço (b.sendToUI) */ });
  ui.save({ cor: 'azul' });       // grava a configuração do botão
  ui.send({ type: 'teste' });     // manda ao serviço (onMessage do botão)
  // ui.getGlobal() -> Promise · ui.setGlobal(obj) · ui.ready · ui.id / ui.language
</script>
```
A tela só consegue agir no **próprio** botão (o host ignora o `id` que ela mandar em mensagens).

## 4. O fio v2 (o que o SDK envia e recebe)
WebSocket `ws://127.0.0.1:<porta>` (a porta vem de `argv[3]`), mensagens JSON `{type, ...}`. Sem eco/confirmação. O botão é sempre `id` (mais `action` e `key` nas mensagens do host).

**Registro** (primeira mensagem): serviço `{type:'hello', protocol:2, role:'plugin', plugin:<id do plugin.json>}`; tela `{type:'hello', protocol:2, role:'ui', id:<id do botão>}`.

| Host → serviço | Vira no SDK |
|---|---|
| `button.add {id, action, key, settings}` | `onAdd` |
| `button.remove {id, action, key}` | `onRemove` |
| `button.down` · `button.press {settings}` · `button.up` (a cada toque, nessa ordem) | `onDown` · `onPress` · `onUp` |
| `button.active {active}` | `onActive` |
| `button.settings {settings}` (alguém salvou) | `onSettings` |
| `message {payload}` (da tela) | `onMessage` |
| `global.settings {settings}` | resolve `getGlobal()` |

| Serviço → host | Vem de |
|---|---|
| `button.set {id, image:{data \| file \| gif \| gifFile \| state}, text}` — estado completo do botão; `state` = índice em `states` do `plugin.json` | `Button.set` |
| `toast {message}` · `button.alert {id}` (hoje só vai para o log do app) | `toast()` · `alert()` |
| `button.settings.save {id, settings}` · `button.settings.get {id}` | `save()` |
| `ui.send {id, payload}` (para a tela) | `sendToUI()` |
| `global.get` · `global.set {settings}` | `getGlobal()` · `setGlobal()` |
| `open {url, params}` · `hotkey {keys}` · `log {level, message}` | `openUrl()` · `hotkey()` · `log()` |

| Tela → host | Host → tela |
|---|---|
| `button.settings.save {settings}` · `button.settings.get` | `button.settings {settings}` (ao abrir e a cada mudança) |
| `plugin.send {payload}` (para o serviço) | `message {payload}` (do serviço) |
| `global.get` · `global.set {settings}` | `global.settings {settings}` |

## 5. Garantias e limites do host
- WebSocket só em 127.0.0.1; páginas só com `Origin` do próprio app; **uma conexão por plugin** (a primeira vence) e só de plugins que o próprio app iniciou.
- Plugins rodam com as permissões do usuário: importe só os que você confia. Só Node (24).
- Arquivos do plugin são servidos só de dentro da pasta dele e nunca `config.json`, `devices.json`, `channels.json`, `buttons.json`, `*.pem`, `package*.json`.

## 6. Mudar de versão
`protocol: 2` no `hello`. Mudanças compatíveis (campos novos) não mudam o número; o host ignora campos que não conhece.

## 7. Plugins do Ulanzi Studio (legado, mantido por compatibilidade)
O app **continua importando e rodando plugins feitos para o Ulanzi Studio** (pasta `*.ulanziPlugin` com `manifest.json`, serviço Node, tela com a biblioteca deles). Eles falam a língua antiga
(`{cmd, uuid, key, actionid}`), que o host traduz para os mesmos eventos internos (`node/src/plugin-protocol.ts`: `decodeUlanzi`/`encodeUlanzi`). A primeira mensagem (`connected` em vez de `hello`) escolhe a língua.
Nada disso é usado pelos plugins do projeto. Dois níveis de uso:

1. **Direto (sem mudar nada):** importe o plugin; ele roda como no Ulanzi Studio, com o SDK dele dentro da pasta.
2. **Adaptado (sem o SDK da Ulanzi):** `sdk/ulanzi-compat.mjs` implementa a classe `UlanziApi` (a do `plugin-common-node`) e a conexão estilo Ulanzi (`UlanziBridge`) **sobre o nosso SDK**. O script troca só o import:
```
node sdk/adaptar-plugin.mjs "<pasta-do-plugin>"             # copia o SDK para <plugin>/deck-sdk/ e troca os imports (guarda <arquivo>.pre-deck-sdk)
node sdk/adaptar-plugin.mjs "<pasta-do-plugin>" --desfazer   # volta ao original
node sdk/adaptar-plugin.mjs "<pasta-do-plugin>" --refazer    # desfaz e adapta de novo (depois de atualizar o SDK)
```
Plugins **empacotados** (um `.js` minificado com o SDK da Ulanzi embutido, como o **Spotify**): o script troca só a classe do cliente do host dentro do bundle por uma sobre o nosso SDK. O remendo é preso ao texto exato do trecho original:
numa versão diferente do plugin ele **não altera nada** e avisa. Não há teste automatizado do remendo (só a conferência com o plugin real); ao atualizar o Spotify, reimporte e rode o script de novo.
**Telas de configuração (HTML):** `node sdk/migrar-tela.mjs "<pasta-do-plugin>" [--desfazer]` troca a biblioteca de navegador da Ulanzi (`libs/js/ulanziApi.js` e companhia) pelo nosso `/deck-ui.js` (guarda `<arquivo>.pre-deck-ui`; só edita a cópia instalada e a tela deixa de funcionar no Ulanzi Studio; se sobrar uma chamada que o script não sabe trocar, não grava nada).
Aplicado em plugins reais e conferido num navegador real (abrir, ler o que o serviço devolve, salvar e ver em `config.json`). Telas que ainda usam a biblioteca da Ulanzi (ex.: as 14 páginas do Spotify, bundles minificados) continuam na língua legada, que o host serve de dentro da pasta do plugin.
Na v2, a tela que salvou **não** recebe o próprio eco (só o serviço e as outras telas do botão): senão o formulário voltaria atrás enquanto o usuário digita.
Cobertura do legado: add/run/clear/setactive/settings/globais/mensagens da tela, ícones tipos 0-4, toast, hotkey, openurl, log. Dial/encoder, `selectdialog` e `openview` não existem aqui.

## 8. Testes
- `cd node && npm run test:sdk` — o SDK contra um host falso e a camada `ulanzi-compat` (25 verificações).
- `npm run test:deck` — o host real com o protocolo v2: plugin escrito com o SDK, tela simulada, configuração do botão e global, segurança (id forjado, Origin, segunda conexão, id de outro botão), importação e remoção (32 verificações).
- `npm run test:plugins` — o host real com um plugin falso na língua legada do Ulanzi (98 verificações).
Exemplos: `docs/exemplo-plugin/ola-mundo.deckplugin` (contador com tela de configuração) e `plugins-proprios/bateria-esp.deckplugin` (plugin real).
