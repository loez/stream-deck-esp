// Instalar plugin pela URL de um repositório do GitHub: converte a URL no .zip do repositório (codeload.github.com), baixa com limites e entrega o arquivo ao host (PluginHost.importFromPath).
// Só repositórios públicos (sem token). Nada é executado aqui: o plugin só roda quando um botão usa uma ação dele, e o app avisa que plugins rodam com as permissões do app.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type GhRef = { owner: string; repo: string; ref: string | null; sub: string };
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
/** Base dos downloads; os testes apontam para um servidor local (DECK_GH_CODELOAD) e então a checagem de domínio é dispensada. */
const base = () => process.env.DECK_GH_CODELOAD || 'https://codeload.github.com';
const MAX_ZIP = 100 * 1024 * 1024;

/** Aceita: https://github.com/dono/repo, .../repo.git, .../tree/<ref>[/pasta], github.com/dono/repo, dono/repo. Lança Error com a razão (em português) se não for um repositório do GitHub. */
export function parseGithubUrl(input: string): GhRef {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('cole a URL do repositório no GitHub');
  s = s.replace(/^git\+/, '').replace(/^git@github\.com:/i, 'https://github.com/');
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) s = 'https://github.com/' + s;   // dono/repo
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u: URL; try { u = new URL(s); } catch { throw new Error('URL inválida'); }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) throw new Error('só são aceitas URLs de repositórios do github.com');
  const parts = u.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
  if (parts.length < 2) throw new Error('a URL precisa ser de um repositório (github.com/dono/repositório)');
  const owner = parts[0]!, repo = parts[1]!.replace(/\.git$/i, '');
  if (!NAME.test(owner) || !NAME.test(repo)) throw new Error('nome de repositório inválido');
  let ref: string | null = null, sub = '';
  if (parts.length > 2) {
    if (parts[2] !== 'tree' && parts[2] !== 'blob') throw new Error('use a URL do repositório (ou de uma pasta: .../tree/<ramo>/<pasta>)');
    if (parts[2] === 'blob') throw new Error('use a URL da pasta do plugin (…/tree/<ramo>/<pasta>), não de um arquivo');
    ref = parts[3] ?? null;
    sub = parts.slice(4).join('/');
    if (ref !== null && !/^[A-Za-z0-9_.\-+@]{1,100}$/.test(ref)) throw new Error('ramo/versão inválido na URL');
    if (sub && sub.split('/').some((x) => x === '..' || x === '.')) throw new Error('pasta inválida na URL');
  }
  return { owner, repo, ref, sub };
}

export const zipUrl = (g: GhRef): string => `${base()}/${g.owner}/${g.repo}/zip/${g.ref ? encodeURIComponent(g.ref) : 'HEAD'}`;

/** Baixa o .zip do repositório para `dest` (máx. 100 MB, 60 s). Lança Error com a razão em português. */
export async function downloadRepoZip(g: GhRef, dest: string): Promise<void> {
  const url = zipUrl(g);
  let res: Response;
  try { res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'StreamDeckESP' } }); }
  catch { throw new Error('não consegui falar com o GitHub (sem internet?)'); }
  if (!process.env.DECK_GH_CODELOAD) { const h = new URL(res.url).hostname; if (!/(^|\.)github(usercontent)?\.com$/i.test(h)) throw new Error('o GitHub redirecionou para um endereço inesperado'); }
  if (res.status === 404) throw new Error('repositório (ou ramo) não encontrado, ou é privado: só repositórios públicos são aceitos');
  if (!res.ok || !res.body) throw new Error(`o GitHub respondeu ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_ZIP) throw new Error('repositório grande demais (máximo 100 MB)');
  let got = 0;
  const limited = Readable.fromWeb(res.body as any).on('data', (c: Buffer) => { got += c.length; if (got > MAX_ZIP) limited.destroy(new Error('repositório grande demais (máximo 100 MB)')); });
  try { await pipeline(limited, fs.createWriteStream(dest, { mode: 0o600 })); }
  catch (e) { fs.rmSync(dest, { force: true }); throw e instanceof Error && /grande demais/.test(e.message) ? e : new Error('o download foi interrompido'); }
}
