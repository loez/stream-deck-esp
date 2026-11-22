// Caminhos e parâmetros de ambiente. Rodando direto do repositório (npm start), config.json, token, uploads e cache ficam em <repositório>/data (fora do git). O app instalado usa a pasta de dados do sistema (app/main.cjs).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Sistema em uso ('darwin' | 'win32' | 'linux'). DECK_PLATFORM força um deles (os testes usam 'darwin' para conferir os comandos do macOS em qualquer máquina). */
export const OS: string = process.env.DECK_PLATFORM || process.platform;
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.DECK_DATA ? path.resolve(process.env.DECK_DATA) : path.resolve(ROOT, '..', 'data');
export const CACHE = process.env.DECK_CACHE ? path.resolve(process.env.DECK_CACHE) : path.resolve(ROOT, '..', 'data', 'cache');
export const ASSETS = path.join(ROOT, 'assets');
export const WEB = path.join(ROOT, 'web');
export const CFG_FILE = path.join(DATA, 'config.json');
export const UPLOADS = path.join(DATA, 'uploads');
export const TOKEN_FILE = path.join(DATA, 'token');
export const PORT = Number(process.env.DECK_PORT || 8765);
export const DRY = Boolean(process.env.DECK_DRYRUN);        // testes: imprime os comandos em vez de executar
export const NOMDNS = Boolean(process.env.DECK_NOMDNS);     // testes: não anuncia na rede

// ---------- plugins (host compatível com o Ulanzi Studio) ----------
import os from 'node:os';
export const PLUGINS_DIR = process.env.DECK_PLUGINS_DIR ? path.resolve(process.env.DECK_PLUGINS_DIR) : path.join(ROOT, 'plugins');   // cópias dos plugins (*.ulanziPlugin)
export const PLUGIN_PORT = Number(process.env.DECK_PLUGIN_PORT || 3907);                  // o Ulanzi Studio usa 3906: os dois convivem
const ULANZI_DEFAULT = OS === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Ulanzi', 'UlanziDeck', 'Plugins')
  : OS === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Ulanzi', 'UlanziDeck', 'Plugins') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Ulanzi', 'UlanziDeck', 'Plugins');   // o Ulanzi Studio só existe para macOS e Windows; no Linux a pasta não existe (importar por pasta/.zip)
export const ULANZI_DIR = process.env.DECK_ULANZI_DIR || ULANZI_DEFAULT;   // origem do "importar"
export const NOPLUGINS = Boolean(process.env.DECK_NOPLUGINS);                              // testes: não sobe o host de plugins

// ---------- troca automática de página pelo app em foco ----------
export const FRONT_FILE = process.env.DECK_FRONT_FILE || '';        // testes: lê "bundleid|Nome" deste arquivo em vez de perguntar ao macOS
export const NOFOCUS = Boolean(process.env.DECK_NOFOCUS);           // testes: desliga o monitor de app em foco

// ---------- grade e fonte escolhidas na página de configuração ----------
export const SETTINGS_FILE = path.join(DATA, 'settings.json');

// ---------- nome do botão ----------
// Padrão: o nome só aparece (com a faixa preta) se o usuário preencheu o título. DECK_DEFAULT_NAMES=1 volta ao comportamento antigo
// (nome derivado da ação, ex.: "Safari", "Vazio"): só o teste de paridade com o servidor Python usa.
export const DEFAULT_NAMES = Boolean(process.env.DECK_DEFAULT_NAMES);
