// Pontos de ligação entre o núcleo (texto, imagem, ações) e o host de plugins, sem importações circulares. O host (plugins.ts) preenche isto ao iniciar.
import type { Button } from './config.ts';
import type { Raster } from './resample.ts';
import type { GifFrames } from './anim.ts';

export type Result = [boolean, string];
export const hooks: {
  pluginLabel?: (b: Button) => string | undefined;            // texto que o plugin pediu para o botão (pode ter quebras de linha)
  lanPeer?: () => string | undefined;                           // IP de um aparelho da rede local que acabou de falar com o servidor (a placa): prova de que ele está ligado, usado para diagnosticar o bloqueio de rede local do macOS
  pluginText?: (b: Button) => string | undefined;             // só o texto que o plugin mandou (sem o nome da ação como alternativa)
  pluginIcon?: (b: Button) => Raster | null | undefined;      // último ícone enviado pelo plugin (ou o ícone da ação, antes de ele enviar)
  pluginAnim?: (b: Button) => { ver: number; gif: GifFrames } | undefined;   // GIF animado que o plugin mandou para o botão (estados tipo 3/4), já decodificado
  pluginVersion?: (b: Button) => number;                      // muda quando o ícone/texto do plugin muda (invalida o cache de imagens)
  pluginPress?: (pid: number, i: number) => Promise<Result>;  // toque no botão
  stateKick?: () => void;                                      // depois de uma ação: o servidor relê o estado dos botões com estado (luz ligada/desligada, mudo)
  pluginValidate?: (a: Record<string, any>) => Record<string, any>;   // valida/normaliza a ação "plugin" vinda da página (lança Error com mensagem)
} = {};
