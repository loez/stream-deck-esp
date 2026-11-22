# Como criar um plugin para o Stream Deck ESP

Um plugin é uma pasta `*.deckplugin` com um `plugin.json`, um **serviço** em Node.js (roda em segundo plano) e, opcionalmente, uma **tela de configuração** em HTML por ação.
Você escreve o serviço com o **SDK do projeto** (`sdk/deck-plugin.mjs`) e a tela com `/deck-ui.js` (servido pelo app). O fio de baixo nível (mensagens) está em [`PROTOCOLO-PLUGIN.md`](PROTOCOLO-PLUGIN.md);
este guia cobre **tudo o que um plugin pode usar e como instalar, distribuir, desenvolver e depurar**. Plugins do Ulanzi Studio também rodam aqui (seção 16), mas **nada do projeto depende deles**.

**Índice:** 1 Plugin ou função nativa? · 2 Começo rápido · 3 Estrutura · 4 `plugin.json` · 5 Como o plugin roda · 6 O serviço (SDK) · 7 Ícones, texto, GIF e estados · 8 Tela de configuração · 9 Configurações e segredos ·
10 Idiomas · 11 Falar com o app (HTTP local) · 12 Instalar e distribuir · 13 Hot-reload · 14 Dependências · 15 Depurar e testar · 16 Ulanzi (legado) · 17 Limites e boas práticas · 18 Receitas · 19 Referência rápida

---

## 1. Plugin ou função nativa?
Antes de criar um plugin, veja se o app já faz. **Funções nativas** (botões que não precisam de plugin):

| Nativo | O que faz |
|---|---|
| Abrir / fechar aplicativo, abrir site, atalho de teclado, digitar texto, mídia e volume | ações do sistema (multiplataforma) |
| Ação múltipla (sequência, ao mesmo tempo, alternar, sorteio) | várias ações num botão |
| Páginas, subpastas, troca automática de página pelo app em foco | navegação |
| **Monitor de Recursos** (CPU, GPU, RAM; anel ou resumo em barras/linha) | números ao vivo do computador, atualiza sozinho |
| **Controle deslizante** (volume do sistema, volume do Spotify/Apple Music, brilho, linha do tempo) | botão juntado arrastado com o dedo; [`CONTROLES-DESLIZANTES.md`](CONTROLES-DESLIZANTES.md) |
| Imagem ou **GIF** próprio no botão | ícone/animação escolhidos pelo usuário |

**Use um plugin quando** o botão precisa de lógica sua: falar com uma API ou aparelho (luzes, ar-condicionado, projetor, Spotify), mostrar um estado que muda (build, e-mail, temperatura), guardar configuração própria com tela de configuração.
Um plugin **desenha o ícone/texto do botão e reage ao toque**; ele não recebe o arrasto de dedo (isso é do controle deslizante nativo) e não mexe na grade nem nas páginas.

## 2. Começo rápido (5 minutos)
1. Copie `docs/exemplo-plugin/ola-mundo.deckplugin` para uma pasta sua (ex.: `~/meu-plugin`). Troque o `id` do `plugin.json` por um seu e único (`com.seunome.meuplugin`; os ids das ações devem começar com ele).
2. No app: **Configurações > Plugins de Terceiros > Importar de outra pasta ou arquivo .zip** e escolha a pasta. As ações aparecem na biblioteca da direita (um grupo por plugin). Arraste uma para um botão.
3. **Desenvolvendo:** em **Desenvolvimento de plugins**, cole o caminho da sua pasta em **Vincular** (o plugin precisa estar instalado). A partir daí, **salvar um arquivo recarrega só o seu plugin** e a placa atualiza sozinha (seção 13).
4. Veja o log do plugin na própria tela de Plugins (ou `DECK_PLUGIN_LOG=1`, seção 15).

## 3. Estrutura da pasta
```
meu-plugin.deckplugin/
├── plugin.json              # obrigatório
├── plugin/app.js            # serviço principal ("main")
├── plugin/deck-plugin.mjs   # cópia do SDK (sdk/deck-plugin.mjs)
├── pi/index.html            # tela de configuração (opcional, uma por ação)
├── resources/               # ícones PNG/GIF/SVG
└── node_modules/            # dependências já instaladas (seção 14)
```
O nome da pasta não precisa terminar em `.deckplugin` ao importar (o app dá o nome), mas **mantenha o `id` estável**: os botões o guardam.

## 4. `plugin.json`
```json
{
  "id": "com.exemplo.olamundo",
  "name": "Olá Mundo",
  "version": "1.0.0", "author": "Você", "description": "texto curto",
  "icon": "resources/icon.png",
  "main": "plugin/app.js",
  "actions": [
    { "id": "com.exemplo.olamundo.contador", "name": "Contador",
      "tooltip": "texto de ajuda", "icon": "resources/icon.png",
      "ui": "pi/index.html",
      "states": [ { "name": "Padrão", "image": "resources/s0.png" }, { "name": "Ligado", "image": "resources/s1.png" } ] }
  ],
  "locales": { "en": { "Olá Mundo": "Hello World", "Contador": "Counter" } }
}
```
| Campo | Obrigatório | Para que serve |
|---|---|---|
| `id` | sim | identidade do plugin (único; não mude depois de publicar) |
| `name`, `version`, `author`, `description`, `icon` | `name` sim | aparecem na tela de Plugins e na biblioteca de ações |
| `main` | sim | serviço Node (`.js`/`.mjs`) **dentro** da pasta (sem `..` nem caminho absoluto) |
| `actions[]` | pelo menos 1 | cada ação é um item arrastável da biblioteca |
| `actions[].id` | sim | id único; no código você usa o nome curto (o que vem depois do último ponto) |
| `actions[].name`, `tooltip`, `icon` | não | nome, dica e ícone na biblioteca |
| `actions[].ui` | não | HTML da tela de configuração (seção 8) |
| `actions[].states[]` | não | ícones prontos (`image`); o `[0]` é o ícone padrão antes do plugin mandar um; use os outros com `image: {state: n}` (seção 7) |
| `locales` | não | traduções do que o **app** mostra do seu plugin (seção 10) |

Regras validadas ao importar: `id`, `name`, `main` e uma ação com `id`; `main` existe dentro da pasta; dois plugins não podem ter o mesmo `id`.

## 5. Como o plugin roda
O app inicia o serviço **só quando algum botão usa uma ação dele**, na pasta do plugin, assim:
```
node plugin/app.js 127.0.0.1 <porta> <idioma> <versão-legada>
        argv[2]    argv[3]  argv[4]  argv[5]
```
O SDK lê isso sozinho. Detalhes:
- O Node embutido é o **24** (`WebSocket` e `fetch` globais existem). O processo herda o ambiente do app (por exemplo `DECK_PORT`, a porta do servidor; o padrão é 8765).
- Se o serviço **cair**, o app reinicia com espera crescente; mais de **5 quedas em 60 s** e ele desiste (a tela de Plugins mostra "com falha"; recarregar na hora destrava).
- Quando nenhum botão usa o plugin, o processo é encerrado. **Não guarde estado de botões em arquivo**: reconstrua-o em `onAdd` (o app reenvia `button.add` a cada início).
- Por padrão o serviço **sai quando o app fecha** a conexão (`plugin.onClose`).
- Roda com as **permissões do usuário**. Só instale plugins em que você confia.

## 6. O serviço (SDK `deck-plugin.mjs`)
Copie `sdk/deck-plugin.mjs` para dentro do plugin (o app não roda `npm install`). Zero dependências.
```js
import { Plugin } from './deck-plugin.mjs';
const plugin = new Plugin();               // endereço/porta: argumentos do processo; id: plugin.json da pasta atual
plugin.action('contador', {                // nome curto (depois do último ponto do id da ação) ou o id completo
  onAdd:      (b) => b.set({ text: 'Toques\n0' }),   // o botão apareceu (b.settings = configuração salva)
  onRemove:   (b) => {},
  onPress:    (b) => { b.state.n = (b.state.n || 0) + 1; b.set({ text: `Toques\n${b.state.n}` }); b.toast('ok'); },
  onDown:     (b) => {}, onUp: (b) => {},    // pressionar / soltar (a cada toque: down, press, up)
  onSettings: (b, settings) => {},           // a configuração do botão mudou (aqui ou na tela)
  onActive:   (b, ativo) => {},              // a página do botão entrou/saiu da placa: pause trabalho caro quando false
  onMessage:  (b, payload) => {},            // mensagem da tela de configuração
});
```
Tratadores podem ser `async`; erro dentro deles vai para o log do plugin e **não derruba** o serviço.

**`Button`** (um botão que usa uma ação sua)
| Membro | O que faz |
|---|---|
| `id`, `action`, `key`, `settings`, `state`, `active` | identidade (`key` = `coluna_linha`), configuração salva, **`state` = área livre sua (não persiste)**, página ativa na placa |
| `set({ image, imageFile, gif, gifFile, text })` | muda ícone/texto; o que você não passa continua como estava |
| `toast(msg)` | aviso curto, devolvido como resultado do toque (na placa o botão pisca a borda verde; o texto aparece ao testar o botão pela página) |
| `alert()` | sinaliza falha do botão (por ora só registra no log do app, sem efeito visual na placa) |
| `save(settings)` | grava a configuração **deste botão** (persiste; chama `onSettings` aqui e na tela) |
| `sendToUI(payload)` | manda uma mensagem à tela de configuração aberta deste botão |

**`Plugin`**
| Membro | O que faz |
|---|---|
| `action(nome, tratadores)` | registra uma ação |
| `list([ação])` | botões ativos (opcionalmente só de uma ação): para atualizar vários de uma vez |
| `getGlobal()` → `Promise` · `setGlobal(obj)` | configuração **global** do plugin (persiste) |
| `openUrl(url[, params])` | abre um endereço http/https no navegador do usuário |
| `hotkey('cmd+shift+4')` | aperta um atalho no computador (`cmd` vira Ctrl fora do Mac) |
| `language` | `'pt-BR'` ou `'en'` (idioma do app, fixo enquanto o plugin roda) |
| `log(msg, nível)` | escreve no log do plugin (`info`, `warn`, `error`) |
| `ready` · `onClose` · `send(msg)` | promessa da conexão · o que fazer ao perder o app · mensagem crua do protocolo (uso avançado) |

## 7. Ícones, texto, GIF e estados
`b.set(...)` aceita:
- `image`: data URI (PNG/JPG/GIF/SVG) ou `Buffer` PNG. **`imageFile`**: caminho dentro da pasta do plugin (`'resources/x.png'`).
- `gif` (base64 ou `Buffer`) / **`gifFile`**: **anima** o botão.
- `text` (com `\n`): desenhado **pelo app** por cima do ícone, **só se o usuário marcou "mostrar na placa o texto que o plugin envia"** no botão (por padrão o nome do botão é o dele). `null` limpa.
- Sem ícone seu: vale o `states[0].image` da ação (ou o `icon`). Para usar outro estado do manifesto mande a mensagem crua: `plugin.send({ type: 'button.set', id: b.id, image: { state: 1 } })`.

Regras e dicas:
- Ícone **quadrado**, 144x144 é o padrão; o app ajusta ao botão (em botão **juntado** o ícone cresce com o menor lado). Desenhe com margens: a faixa do nome cobre a parte de baixo quando o botão tem título.
- Reenviar o **mesmo** ícone não custa nada (o app compara), mas não mande `set` em alta frequência: cada ícone novo reenvia a imagem à placa. Atualize no máximo uma vez por segundo.
- **GIF:** no máximo **8 botões animados por página** e ~3 MB de quadros por página (a placa tem pouca RAM; o app reduz quadros se passar); arquivo até 25 MB. Prefira poucos quadros e ícone pequeno.
- Para gerar ícones sem biblioteca, SVG em data URI resolve (veja `plugins-proprios/bateria-esp.deckplugin`, e o PNG de cor sólida do exemplo).

## 8. Tela de configuração (`ui`)
Se a ação tem `ui`, o app abre esse HTML num iframe da página de configuração, ao selecionar o botão. Inclua `<script src="/deck-ui.js"></script>`; a página recebe na URL `port`, `address`, `id` (do botão), `plugin`, `action`, `key`, `language`.
```html
<script src="/deck-ui.js"></script>
<form id="f"><input name="cor"><button>Salvar</button></form>
<script>
  const ui = new DeckUI();
  ui.onSettings((s) => DeckUI.setFormValue(s, '#f'));                 // preenche agora e a cada mudança
  document.getElementById('f').onsubmit = (e) => { e.preventDefault(); ui.save(DeckUI.formValue('#f')); };
  ui.onMessage((payload) => { /* mensagem do serviço (b.sendToUI) */ });
  ui.send({ type: 'teste' });                                          // vai para o onMessage do botão
  // ui.getGlobal() -> Promise · ui.setGlobal(obj) · ui.ready · ui.id · ui.language ('pt_BR' | 'en')
</script>
```
Utilitários: `DeckUI.formValue(form)`, `DeckUI.setFormValue(valores, form)`, `DeckUI.debounce(fn, ms)` (salvar enquanto digita), `DeckUI.query('nome')`.
- A tela só age no **próprio** botão (o app ignora o `id` que ela mandar). Ela **não** recebe o próprio eco de `save` (senão o formulário voltaria atrás enquanto se digita).
- Só os arquivos **do plugin** são servidos (nunca `config.json`, `devices.json`, `channels.json`, `buttons.json`, `*.pem`, `package*.json`).
- Estilize no padrão escuro do app (fundo `#16171b`, texto claro). Para falar com o serviço (listar aparelhos, testar uma chave) use `ui.send` e responda com `b.sendToUI`.

## 9. Configurações e segredos
| O quê | Onde fica | API |
|---|---|---|
| Configuração **de um botão** (cor, aparelho, intervalo) | `config.json` do app (junto com o botão; some quando o botão é apagado) | `b.settings`, `b.save()`, `onSettings`; na tela: `ui.save`, `ui.onSettings` |
| Configuração **global** do plugin (conta, preferências) | arquivo do app, por plugin (apagado quando você apaga o plugin) | `getGlobal()`, `setGlobal()` |
| **Segredos** (tokens, chaves, certificados) | `config.json` ou `*.pem` **na pasta do plugin** (0600, nunca servidos) | `fs` do Node |
Estado de execução (contadores, cache) fica na memória do serviço (`b.state`); ele é refeito a cada início.

## 10. Idiomas
O app é pt-BR e inglês ([`TRADUCAO.md`](TRADUCAO.md)). O serviço lê `plugin.language` (`'pt-BR'` | `'en'`; fixo até o plugin reiniciar, o que acontece ao trocar de idioma só quando o app reinicia) e a tela lê `ui.language`.
Para traduzir o que o **app** mostra do seu plugin (nome, descrição, ações, dicas), use `locales` no `plugin.json` (a chave é o texto original; sem tradução aparece o original). O que o **plugin** envia (`toast`, `text`) e a própria tela, você traduz.

## 11. Falar com o app (HTTP local)
Seu serviço pode consultar e controlar o app por HTTP em `http://127.0.0.1:${process.env.DECK_PORT || 8765}`. São chamadas **locais** (sem token; pedidos de outros sites são recusados). Úteis:

| Chamada | Para quê |
|---|---|
| `GET /api/resources` | `{cpu, gpu, ram:{percent, usedGB, totalGB}}` do computador (CPU na 1ª leitura é `null`) |
| `GET /api/status` | placa conectada, `battery` (`percent`, `volts`), `display` (brilho/tela apagada), página atual |
| `POST /api/display` `{op: up\|down\|set\|off\|on\|toggle, value?}` | brilho e tela apagada da placa |
| `GET /api/config` · `GET /api/settings` | páginas, botões e grade |
| `POST /api/current/<página>` | mostrar uma página na placa |
| `POST /api/test/<página>/<slot>` | "tocar" um botão (executa a ação dele) |
| `GET /api/preview/<página>/<slot>.png` | imagem atual de um botão |
| `GET /api/usb` | estado da conexão da placa por cabo ([`PROTOCOLO-USB.md`](PROTOCOLO-USB.md)) |
O `plugins-proprios/bateria-esp.deckplugin` é o exemplo real: lê `/api/status` e chama `/api/display`. Evite laços apertados; 2 a 5 segundos bastam.

## 12. Instalar e distribuir
Em **Configurações > Plugins de Terceiros**:
- **Instalar do GitHub:** cole a URL de um repositório **público** (`https://github.com/dono/repo`, `dono/repo`, ou uma pasta: `https://github.com/dono/repo/tree/<ramo>/<pasta>`). O app baixa o `.zip` (máx. 100 MB), acha o plugin (na raiz ou em subpastas, até 3 níveis; se houver vários, a mensagem lista as pastas e você usa a URL `/tree/...`) e instala. O nome do ramo/tag não pode ter `/`.
- **Arrastar um `.zip`** para a área da tela, para a grade ou para qualquer ponto da janela: o servidor valida e instala (máx. 200 MB; protegido contra "zip slip").
- **Importar de outra pasta ou .zip:** `Escolher pasta…`, `Escolher .zip…` ou cole o caminho completo. **Procurar plugins no Ulanzi Studio** copia os já instalados lá (só macOS/Windows).
- **Atualizar:** instalar de novo um plugin com o **mesmo `id`** (por URL ou .zip) **atualiza no lugar**: botões e configurações locais (`config.json`, certificados, `buttons.json`) ficam e o serviço reinicia. Importar por pasta com um id já existente é recusado ("já existe"): use a pasta vinculada (seção 13), URL ou .zip.
- **Apagar:** botão **Apagar** do plugin: para o serviço, remove a pasta e as configurações globais e **limpa todo botão que usa uma ação dele** (em todas as páginas e subpastas; um botão juntado mantém o tamanho). Não dá para desfazer.
- O app **valida o manifesto**, **copia** para a pasta de plugins (macOS: `~/Library/Application Support/Stream Deck ESP/plugins/`; nos outros sistemas, `plugins/` dentro dos dados do app, ou `DECK_PLUGINS_DIR`), ignora `.git`/`__MACOSX` e atalhos (symlinks) que apontem para fora, deixa `config.json`/`*.pem` em 0600 e **nunca executa nada** na instalação.
- A instalação por URL/.zip pede confirmação (**plugins rodam com as permissões do app**).

**Publicando no GitHub:** deixe o `plugin.json` na raiz do repositório (ou em uma pasta e divulgue a URL `/tree/...`), **inclua `node_modules` já instalado** se usar dependências (o app não roda `npm install`), mantenha o `id` estável e suba a `version` a cada mudança. Quem tiver a URL instala e atualiza colando-a de novo.
Endpoints (só localhost, com `Content-Type` exato: `application/json` ou `application/zip`; pedidos com `Origin` de outro site são recusados): `POST /api/plugins/install-url {url}`, `POST /api/plugins/upload` (corpo = o .zip), `POST /api/plugins/import {path}`, `DELETE /api/plugins/<id>`. Código: `node/src/plugin-install.ts` e `PluginHost.importFromPath`.

## 13. Hot-reload (desenvolvimento)
Em **Desenvolvimento de plugins** (mesma tela; `POST /api/plugins/dev`):
- **Vincular pasta:** aponte a pasta do **seu código** (com o mesmo `id` do plugin instalado). Ao salvar um arquivo nela, o app valida o `plugin.json`, copia por cima da cópia instalada e **reinicia só esse plugin**; a placa atualiza sozinha, sem reiniciar o app. Manifesto quebrado no meio da edição: aparece o erro na tela e **continua rodando a versão anterior**.
- **Modo desenvolvedor:** recarrega um plugin quando você salva arquivos da **própria cópia instalada**. Arquivos que o plugin grava sozinho (`config.json`, `buttons.json`, `devices.json`, `state.json`, `settings.json`...) não disparam recarga (evita laço). Reage a `.js .mjs .cjs .html .css .json` e imagens.
- **Recarregar** (botão): reinicia o plugin na hora (também limpa o estado "com falha"). A tela mostra "Recarregado às hh:mm:ss (motivo)".
- Seus botões, a configuração do botão e a global **não** são perdidos na recarga. Mudar o **`id`** é outra coisa: desvincule e instale de novo.
- A preferência fica em `plugin-dev.json` nos dados do app (`DECK_DATA`).

## 14. Dependências (`node_modules`)
O app **não roda `npm install`** ao importar: leve o `node_modules` pronto dentro da pasta (ou não use dependências, como o exemplo). Módulos nativos precisam ser compilados para o sistema e a arquitetura de quem vai usar (macOS, Windows e Linux): **prefira JavaScript puro**.
O servidor embute `ws` e `@napi-rs/canvas`, mas isso **não vale para o plugin** (cada plugin resolve a partir da própria pasta). `WebSocket` e `fetch` já existem no Node 24.

## 15. Depurar e testar
- **Log do plugin** (últimas linhas de stdout/stderr e de `plugin.log()`): tela de Plugins, ou `curl localhost:8765/api/plugins` (campo `log`). Ao vivo no terminal: `DECK_PLUGIN_LOG=1` ao rodar o servidor (`cd node && ./iniciar.sh`).
- **Instância isolada** (não toca nos seus dados): `DECK_DATA=$(mktemp -d) DECK_PORT=8821 DECK_PLUGIN_PORT=3927 DECK_NOMDNS=1 DECK_DRYRUN=1 DECK_PLUGINS_DIR=$DECK_DATA/plugins DECK_ULANZI_DIR=$DECK_DATA/nada node src/main.ts`.
- **Sem a placa:** atribua com `POST /api/button/<página>/<slot>/plugin` `{"plugin":"<id>","action":"<id da ação>"}`, toque com `POST /api/test/<página>/<slot>` (devolve o `toast`) e veja o ícone em `GET /api/preview/<página>/<slot>.png`.
- **Testes automatizados** (use como modelo): `cd node && npm run test:sdk` (SDK contra um host falso), `npm run test:deck` (host real + protocolo v2: tela simulada, configuração, segurança), `npm run test:plugins` (língua legada do Ulanzi), `npm run test:install` (instalação por URL/.zip e hot-reload).
- Erros comuns: `EHOSTUNREACH` imediato no macOS = permissão de **Rede Local** negada ao app (Ajustes > Privacidade e Segurança > Rede Local; o app avisa na tela de Plugins); "com falha" = o serviço caiu 5 vezes em 60 s (veja o log); botão cinza/`...` = o plugin ainda não mandou ícone.

## 16. Plugins do Ulanzi Studio (legado)
Pastas `*.ulanziPlugin` (com `manifest.json` e o SDK da Ulanzi dentro) continuam sendo importadas e rodam aqui, falando a língua antiga que o host traduz (`node/src/plugin-protocol.ts`). Só plugins cujo serviço é JavaScript (Type `JavaScript`, `CodePath` `.js`); o que roda no navegador deles (HTML, ex.: OpenWeather) **não** é suportado.
Para tirar o SDK da Ulanzi de dentro deles use `sdk/adaptar-plugin.mjs` (e `sdk/migrar-tela.mjs` para as telas); detalhes em [`PROTOCOLO-PLUGIN.md`](PROTOCOLO-PLUGIN.md), seção 7. Dial/encoder, `selectdialog` e `openview` não existem aqui.

## 17. Limites e boas práticas
- **Segurança:** o plugin roda com as permissões do usuário; só instale de quem confia. O WebSocket do host fica só em `127.0.0.1`, aceita páginas só com `Origin` do próprio app e **uma conexão por plugin** (a primeira vence, e só de plugins que o app iniciou).
- **Segredos** em `config.json`/`*.pem` na pasta do plugin (0600, não servidos), nunca no código nem no repositório. Ao publicar, **não suba** seu `config.json` (a atualização também preserva o do usuário).
- **Porta fixa:** se o plugin abre um servidor próprio, torne a porta **configurável**: o Ulanzi Studio pode estar aberto e conflitar (foi o caso do Spotify na 30901).
- **Aparelhos desligados** somem da rede: trate erro de conexão com tentativas espaçadas (backoff). Não deixe uma promessa rejeitada sem tratar em laços.
- **Atalhos e abrir endereços** passam pelo app (`hotkey`, `openUrl`): não chame `open`/`osascript`/`xdotool` do plugin se der para evitar; o app usa o mecanismo certo de cada sistema.
- **Placa:** pouca RAM e tela pequena. Poucos ícones animados, ícones simples, textos curtos (a fonte da placa não tem todos os símbolos: setas, ✓ etc. viram equivalentes ASCII ou somem).
- **Só Node.js** (o app não roda Python/Go de forma gerenciada, embora o plugin possa usar `child_process`).
- **Multiplataforma:** o app roda em macOS, Windows e Linux. Teste em mais de um se puder; use `path`, nunca barras fixas.
- **Estado dos botões:** reconstrua em `onAdd`/`onRemove`; use `onActive` para pausar consultas quando a página não está na placa.

## 18. Receitas
**Contador com configuração** (o exemplo completo está em `docs/exemplo-plugin/`):
```js
plugin.action('contador', {
  onAdd:   (b) => desenhar(b),
  onPress: (b) => { b.state.n = (b.state.n || 0) + 1; desenhar(b); b.toast(`Toques: ${b.state.n}`); },
  onSettings: (b) => desenhar(b),                       // a cor veio da tela de configuração
});
const desenhar = (b) => b.set({ image: icone(b.settings.cor || 'azul'), text: `Toques\n${b.state.n || 0}` });
```
**Consultar uma API a cada 30 s só enquanto a página está na placa:**
```js
setInterval(async () => {
  for (const b of plugin.list('tempo').filter((x) => x.active)) {
    try { const r = await (await fetch(`https://api.exemplo/clima?c=${b.settings.cidade}`)).json(); b.set({ text: `${r.temp}°C` }); }
    catch (e) { plugin.log(`clima: ${e}`, 'error'); b.set({ text: 'sem dados' }); }
  }
}, 30_000);
```
**Mostrar o uso de CPU/RAM do computador num botão de plugin** (alternativa ao Monitor de Recursos nativo, para um visual seu):
```js
const BASE = `http://127.0.0.1:${process.env.DECK_PORT || 8765}`;
setInterval(async () => { const r = await (await fetch(BASE + '/api/resources')).json(); plugin.list('cpu').forEach((b) => b.set({ text: `CPU\n${r.cpu ?? '--'}%` })); }, 3000);
```
**Tela e serviço conversando** (listar aparelhos na tela):
```js
// serviço
plugin.action('luz', { onMessage: async (b, p) => { if (p.type === 'listar') b.sendToUI({ type: 'aparelhos', lista: await descobrir() }); } });
// tela
ui.onMessage((m) => { if (m.type === 'aparelhos') preencherSelect(m.lista); }); ui.send({ type: 'listar' });
```
**Configuração global** (uma conta para todos os botões do plugin): `await plugin.getGlobal()` no início e `plugin.setGlobal({ token })` na tela de login (`ui.setGlobal`).

## 19. Referência rápida
- Mensagens do protocolo, tabelas Host ↔ serviço ↔ tela: [`PROTOCOLO-PLUGIN.md`](PROTOCOLO-PLUGIN.md).
- Exemplos: `docs/exemplo-plugin/ola-mundo.deckplugin` (contador com tela de configuração, sem dependências) e `plugins-proprios/bateria-esp.deckplugin` (plugin real: bateria, brilho e tela da placa).
- Código do host: `node/src/plugins.ts`, `node/src/plugin-protocol.ts`, `node/src/plugin-install.ts`. SDKs: `sdk/deck-plugin.mjs` (serviço), `node/web/deck-ui.js` (tela).
- Controles deslizantes nativos: [`CONTROLES-DESLIZANTES.md`](CONTROLES-DESLIZANTES.md). Conexão da placa por cabo: [`PROTOCOLO-USB.md`](PROTOCOLO-USB.md). Plataformas: [`PLATAFORMAS.md`](PLATAFORMAS.md). Idiomas: [`TRADUCAO.md`](TRADUCAO.md).
