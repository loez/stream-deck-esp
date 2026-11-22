# Idiomas do app (i18n)

*[English](en/TRANSLATION.md)*

O app é multi-idioma: **português do Brasil** (base) e **inglês**. O idioma é escolhido em *Configurações > Placa e tela > Idioma*, vale para a página, para as mensagens do servidor, para o menu/diálogos do app Electron e para os plugins, e fica em `settings.json` (`lang`: `pt` ou `en`).
Na primeira abertura, sem escolha, a página segue o idioma do navegador (português se for `pt*`, senão inglês); o app Electron segue o idioma do sistema.

## Como funciona
O **texto em português é a chave** (estilo gettext): sem tradução, ou em `pt`, nada muda e o código continua legível.

| Onde | Como |
|---|---|
| Servidor (`node/src`) | `tr('texto')`, `tr('olá {nome}', { nome })` (`src/i18n.ts`). As respostas JSON passam por `trBody`, que traduz os campos `erro`, `msg`, `why`, `toast` e `message`: por isso `send(res, 400, { erro: 'pedido inválido' })` já sai traduzido. Mensagens montadas com valores (`` `máximo de ${n} páginas` ``) são casadas por `EN_PATTERNS` (regex → modelo com `$1`), ou use `tr` com `{var}`. |
| Página (`node/web/index.html`) | `t('texto')`, `t('olá {nome}', { nome })`, `plural(n, '1 item', '{n} itens')`. Textos fixos do HTML: `data-i18n` (conteúdo) e atributos `title`/`placeholder`/`aria-label` (traduzidos sozinhos). O dicionário vem de `GET /api/i18n`. |
| Dicionário | `node/src/locales/en.ts` (`EN` e `EN_PATTERNS`), usado pelo servidor e enviado à página. |
| App Electron (`app/main.cjs`) | tabela `EN` própria no começo do arquivo e `L('texto', {vars})`. |
| Plugins | o app passa o idioma ao iniciar o plugin (`plugin.language`: `'pt-BR'` ou `'en'`; fixo até o plugin reiniciar) e à tela (`ui.language`, parâmetro `language` da URL). Nomes e descrições do `plugin.json` podem ter `"locales": { "en": { "<texto em português>": "<texto em inglês>" } }`. |

## Regras
- Dado do usuário **não** é traduzido (nomes de páginas, títulos de botões). Os nomes criados pelo app (página nova, botão "Voltar" da subpasta) saem no idioma da hora da criação e depois são dados como os outros.
- Mantenha as mesmas `{variáveis}` no original e na tradução.
- Sem `${...}` dentro de `t('...')`: use variáveis.
- O firmware da placa (portal de Wi-Fi, serial) **ainda não** é traduzido.

## Adicionar um idioma
1. Em `src/i18n.ts`, acrescente o código em `LANGS`, o nome em `LANG_NAMES` e o dicionário em `DICTS`; crie `src/locales/<codigo>.ts` copiando `en.ts`.
2. Em `app/main.cjs`, acrescente a tabela do idioma e ajuste `lang()`/`L()`.
3. `cd node && npm run test:i18n` confere se toda chave `t('...')` da página tem tradução e se as `{variáveis}` batem (hoje só para o inglês: generalize o teste para o novo idioma).
