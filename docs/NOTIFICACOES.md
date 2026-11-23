# Notificações do navegador na placa

*[English](en/NOTIFICATIONS.md)*

Os avisos que os sites mostram no Chrome (Gmail, WhatsApp Web etc.) aparecem num botão **Notificações** da placa. Tocar nele abre o **histórico**, com rolagem.

## Como funciona
1. A extensão `extension/` copia cada notificação criada pelo site (`new Notification(...)` e `registration.showNotification(...)`) e a envia para `POST /api/notify` do servidor local, com uma **chave própria** (cabeçalho `X-Deck-Notify`), separada da chave da placa.
2. O servidor guarda os últimos 50 avisos **só em memória** (somem ao fechar o app) e o botão **Notificações** mostra o último e quantos não foram lidos.
3. Tocar no botão abre uma página temporária: **Voltar**, **▲/▼** (rolam a lista; mostram a faixa `1-4/12`), **Limpar** e as mensagens. Tocar numa mensagem a **dispensa**. A página nunca é gravada na configuração.

## Instalar
1. Em **Configurações → Notificações** da página do servidor, copie a **porta** e a **chave**.
2. No Chrome: `chrome://extensions` → ativar **Modo do desenvolvedor** → **Carregar sem compactação** → escolher a pasta `extension/` do projeto.
3. Nas opções da extensão, cole a porta e a chave e use **Enviar teste**.
4. Na página de configuração, adicione o botão **Notificações** (widgets) a uma página.

## Limites
- Só pega o que o **site chama na própria página**. Notificações de *push* entregues por service worker com a aba fechada não passam pela extensão.
- Precisa do computador ligado (não funciona no modo autônomo da placa); a placa atualiza em até ~1,5 s (Wi-Fi) ou ~0,6 s (USB).
- Só aceita pedidos do próprio computador (`127.0.0.1`) com a chave certa; **Gerar nova chave** invalida a anterior. O servidor limita 30 avisos por minuto e 400 caracteres por aviso, e nada é baixado dos links ou ícones.
- O conteúdo dos avisos pode ser privado: ele fica só na memória do servidor e aparece na tela da placa.
