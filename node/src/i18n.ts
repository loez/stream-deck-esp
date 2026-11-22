// Idiomas do app. O português do Brasil é o idioma-base: o próprio texto em português é a chave (estilo gettext),
// então sem tradução (ou em 'pt') nada muda. Cada idioma novo é um arquivo em locales/ (ver docs/TRADUCAO.md).
//   tr('texto em português')                 -> texto no idioma atual
//   tr('removido {n} botões', { n: 3 })     -> com variáveis {nome}
// Mensagens montadas com valores (`máximo de ${n} páginas`) são traduzidas por PATTERNS (regex -> modelo com $1).
import { EN, EN_PATTERNS } from './locales/en.ts';

export const LANGS = ['pt', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_NAMES: Record<Lang, string> = { pt: 'Português (Brasil)', en: 'English' };
const DICTS: Record<Lang, { dict: Record<string, string>; patterns: [string, string][] }> = { pt: { dict: {}, patterns: [] }, en: { dict: EN, patterns: EN_PATTERNS } };
const COMPILED: Record<string, [RegExp, string][]> = {};

let lang: Lang = 'pt';
export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);
export const setLang = (l: unknown): void => { lang = isLang(l) ? l : 'pt'; };
export const getLang = (): Lang => lang;
/** Dicionário (chave em português -> texto) que a página precisa para o idioma `l`. */
export const dictFor = (l: Lang = lang): Record<string, string> => DICTS[l].dict;

function patterns(l: Lang): [RegExp, string][] {
  return COMPILED[l] ??= DICTS[l].patterns.map(([re, to]) => [new RegExp(re, 's'), to] as [RegExp, string]);
}

export function tr(s: string, vars?: Record<string, string | number>, l: Lang = lang): string {
  let out = DICTS[l].dict[s];
  if (out === undefined) {
    out = s;
    for (const [re, to] of patterns(l)) if (re.test(s)) { out = s.replace(re, to); break; }
  }
  return vars ? out.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : out;
}

/** Traduz, num corpo de resposta JSON, os campos que são mensagens para o usuário (erro, msg, why, toast, message), em qualquer profundidade. */
const MSG_KEYS = new Set(['erro', 'msg', 'why', 'toast', 'message']);
export function trBody<T>(body: T): T {
  if (lang === 'pt') return body;
  const walk = (v: any, depth: number): any => {
    if (depth > 4 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[k] = MSG_KEYS.has(k) && typeof x === 'string' ? tr(x) : walk(x, depth + 1);
    return o;
  };
  return walk(body, 0);
}
