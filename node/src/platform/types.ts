// Camada de sistema: tudo que muda entre macOS, Windows e Linux (abrir apps, atalhos, mídia, app em foco, lista de apps e ícones, seletor de arquivos, .zip).
// Uma implementação por sistema (mac.ts, win.ts, linux.ts); platform/index.ts escolhe a do sistema em uso. Quem chama (actions, apps, focus, plugins, server) não sabe qual é.
export type Result = [boolean, string];
export type Key = ['code', number] | ['char', string];   // 'code' = código de tecla do macOS (a página de atalhos guarda assim); 'char' = um caractere
export type Front = { bundle: string; name: string };    // app em foco: bundle = identificador estável (bundle id no Mac, nome do .exe no Windows, WM_CLASS no Linux)
export type AppInfo = { name: string; path: string };     // path = .app (Mac), atalho .lnk (Windows), arquivo .desktop (Linux)

/** O que o player de música está tocando (botão "Tocando agora"). art = URL (http/https/file) da capa, quando o player informa. */
export type NowPlaying = { app: string; state: 'playing' | 'paused'; title: string; artist: string; art?: string };

export interface Platform {
  id: 'darwin' | 'win32' | 'linux';
  /** Nome para mensagens ao usuário. */
  osName: string;
  openApp(name: string, p: string): Promise<Result>;
  quitApp(target: string): Promise<Result>;
  openUrl(u: string): Promise<Result>;
  /** mods: control | option | shift | command (já validados); command vira Ctrl fora do Mac. */
  hotkey(mods: string[], key: Key): Promise<Result>;
  typeText(text: string, enter: boolean): Promise<Result>;
  media(k: string): Promise<Result>;
  /** App em foco agora (null se não deu para saber, ex.: Linux com Wayland puro). */
  front(): Promise<Front | null>;
  /** O caminho é um app instalado (usado para escolher entre o caminho e o nome)? */
  isAppPath(p: string): boolean;
  listApps(): AppInfo[];
  /** Identificador estável do app (casa com Front.bundle); '' se não souber. */
  appId(appPath: string): Promise<string>;
  /** Grava o ícone do app como PNG (até ~256 px) em out. */
  extractIcon(appPath: string, out: string): Promise<boolean>;
  /** Abre o seletor nativo de pasta/arquivo; devolve o caminho ou ''. */
  pickPath(kind: 'folder' | 'zip'): Promise<string>;
  /** Extrai um .zip em dest (lança se falhar). */
  unzip(zip: string, dest: string): void;
  /** Leituras do sistema para o Monitor de Recursos: uso da GPU (0-100, null se não der para ler) e RAM em uso (bytes, null = usar o cálculo genérico do Node). */
  resources(): Promise<{ gpu: number | null; ramUsed: number | null }>;
  /** Controles deslizantes: volume geral do sistema (0-100; null se não deu para ler) e volume do app de música (app = 'spotify' | 'music'; só onde o próprio app permite). */
  volumeGet(): Promise<number | null>;
  volumeSet(pct: number): Promise<boolean>;
  appVolumeGet(app: string): Promise<number | null>;
  appVolumeSet(app: string, pct: number): Promise<Result>;
  /** Faixa em reprodução (ou pausada) no Spotify/Music (Mac) ou em qualquer player MPRIS (Linux, via playerctl). null = nada tocando ou sem suporte (Windows ainda não). */
  nowPlaying?(): Promise<NowPlaying | null>;
  /** Som do sistema mudo? null = não deu para ler (ou sem suporte). */
  muted?(): Promise<boolean | null>;
  /** Janelas/overlays do sistema que roubam o foco por instantes (não contam como "app em foco"). */
  transient: Set<string>;
}

/** Código de tecla do macOS -> nome canônico (para montar o atalho no Windows/Linux). */
export const KEYNAME: Record<number, string> = { 36: 'enter', 48: 'tab', 49: 'space', 51: 'backspace', 53: 'escape', 117: 'delete', 123: 'left', 124: 'right', 125: 'down', 126: 'up',
  115: 'home', 119: 'end', 116: 'pageup', 121: 'pagedown', 122: 'f1', 120: 'f2', 99: 'f3', 118: 'f4', 96: 'f5', 97: 'f6', 98: 'f7', 100: 'f8', 101: 'f9', 109: 'f10', 103: 'f11', 111: 'f12' };
export const keyName = (k: Key): string => (k[0] === 'code' ? KEYNAME[k[1]] ?? '' : k[1].toLowerCase());
