// Helpers que reproduzem as regras do Python usadas no servidor original (para a paridade de comportamento nos casos de borda).

/** str(v) do Python para os tipos que chegam de JSON. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return JSON.stringify(v);
}

/** int(v) do Python: aceita int, float (trunca), bool e string numérica; erro (null) nos demais casos. */
export function pyInt(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v.trim());
  return null;
}

/** bool(v) do Python. */
export function pyBool(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/** Fatia por pontos de código (como o s[a:b] do Python), não por unidades UTF-16. */
export const cps = (s: string): string[] => Array.from(s);
export const slice = (s: string, a: number, b?: number): string => cps(s).slice(a, b).join('');

/** str.strip() do Python (espaços Unicode). */
export const strip = (s: string): string => s.trim();

/** repr() de uma lista de strings no formato do Python (para o log do modo de teste, comparável com o servidor original). */
export function pyRepr(list: string[]): string {
  const one = (s: string): string => {
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = q;
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (ch === '\\') out += '\\\\';
      else if (ch === q) out += '\\' + q;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
      else out += ch;
    }
    return out + q;
  };
  return '[' + list.map(one).join(', ') + ']';
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Regex de hex "#rrggbb" do hex_rgb do Python (o 1º caractere é ignorado; precisa de 3 pares hexadecimais). */
export function hexRgb(s: unknown): [number, number, number] | null {
  if (typeof s !== 'string') return null;
  const m = /^[\s\S]([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/.exec(s);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null;
}
