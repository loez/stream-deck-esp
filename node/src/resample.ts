// Reamostragem idêntica à do Pillow (ImagingResample): convolução separável (horizontal e depois vertical) com núcleo bicúbico (a=-0.5) ou Lanczos 3,
// coeficientes normalizados e aritmética de ponto fixo de 22 bits, resultado de 8 bits entre as passagens. RGBA é pré-multiplicado antes (como o Pillow faz).
// Motivo: o Skia reduz imagens de outro jeito; para ícones quase sem saturação isso muda a cor dominante e o fundo do botão. Aqui o resultado bate com o servidor Python.
export type Raster = { w: number; h: number; data: Uint8ClampedArray };   // RGBA não pré-multiplicado
export type Filter = 'bicubic' | 'lanczos';

const PREC = 22, ONE = 1 << PREC;
const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const KERNEL: Record<Filter, { support: number; f: (x: number) => number }> = {
  bicubic: { support: 2, f: (x) => { x = Math.abs(x); const a = -0.5; return x < 1 ? ((a + 2) * x - (a + 3)) * x * x + 1 : x < 2 ? (((x - 5) * x + 8) * x - 4) * a : 0; } },
  lanczos: { support: 3, f: (x) => (x > -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0) },
};

type Coeffs = { xmin: Int32Array; n: Int32Array; k: Int32Array[]; first: number; last: number };
function coeffs(inSize: number, outSize: number, b0: number, b1: number, filter: Filter): Coeffs {
  const scale = (b1 - b0) / outSize, fscale = Math.max(scale, 1), support = KERNEL[filter].support * fscale, f = KERNEL[filter].f;
  const xmin = new Int32Array(outSize), n = new Int32Array(outSize), k: Int32Array[] = [];
  let first = inSize, last = 0;
  for (let xx = 0; xx < outSize; xx++) {
    const center = b0 + (xx + 0.5) * scale;
    let lo = Math.trunc(center - support + 0.5), hi = Math.trunc(center + support + 0.5);
    if (lo < 0) lo = 0; if (hi > inSize) hi = inSize;
    const cnt = hi - lo, w = new Float64Array(cnt); let ww = 0;
    for (let x = 0; x < cnt; x++) { w[x] = f((x + lo - center + 0.5) / fscale); ww += w[x]!; }
    const ki = new Int32Array(cnt);
    for (let x = 0; x < cnt; x++) { const v = ww !== 0 ? w[x]! / ww : w[x]!; ki[x] = Math.trunc(v * ONE + (v < 0 ? -0.5 : 0.5)); }
    xmin[xx] = lo; n[xx] = cnt; k.push(ki); first = Math.min(first, lo); last = Math.max(last, hi);
  }
  return { xmin, n, k, first, last };
}
const clip8 = (v: number) => { const r = Math.floor(v / ONE); return r < 0 ? 0 : r > 255 ? 255 : r; };
const mul255 = (c: number, a: number) => { const t = c * a + 128; return (t + (t >> 8)) >> 8; };   // MULDIV255 do Pillow

/** Image.resize((outW, outH), filter, box) do Pillow. `alpha`: modo RGBA (pré-multiplica); senão o canal alfa é copiado como 255 (RGB). */
export function pilResize(src: Raster, outW: number, outH: number, filter: Filter, alpha: boolean, box?: [number, number, number, number]): Raster {
  const [bx0, by0, bx1, by1] = box ?? [0, 0, src.w, src.h];
  const cx = coeffs(src.w, outW, bx0, bx1, filter), cy = coeffs(src.h, outH, by0, by1, filter);
  // entrada (pré-multiplicada se RGBA)
  const inp = new Uint8Array(src.w * src.h * 4);
  for (let p = 0; p < src.w * src.h * 4; p += 4) {
    const a = alpha ? src.data[p + 3]! : 255;
    if (alpha) { inp[p] = mul255(src.data[p]!, a); inp[p + 1] = mul255(src.data[p + 1]!, a); inp[p + 2] = mul255(src.data[p + 2]!, a); } else { inp[p] = src.data[p]!; inp[p + 1] = src.data[p + 1]!; inp[p + 2] = src.data[p + 2]!; }
    inp[p + 3] = a;
  }
  // passagem horizontal (só as linhas que a vertical vai usar)
  const rows = cy.last - cy.first, mid = new Uint8Array(outW * rows * 4);
  for (let y = 0; y < rows; y++) {
    const row = (y + cy.first) * src.w * 4;
    for (let xx = 0; xx < outW; xx++) {
      const kk = cx.k[xx]!, lo = cx.xmin[xx]!, n = cx.n[xx]!; let s0 = ONE / 2, s1 = s0, s2 = s0, s3 = s0;
      for (let x = 0; x < n; x++) { const q = row + (lo + x) * 4, w = kk[x]!; s0 += inp[q]! * w; s1 += inp[q + 1]! * w; s2 += inp[q + 2]! * w; s3 += inp[q + 3]! * w; }
      const o = (y * outW + xx) * 4; mid[o] = clip8(s0); mid[o + 1] = clip8(s1); mid[o + 2] = clip8(s2); mid[o + 3] = clip8(s3);
    }
  }
  // passagem vertical
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let yy = 0; yy < outH; yy++) {
    const kk = cy.k[yy]!, lo = cy.xmin[yy]! - cy.first, n = cy.n[yy]!;
    for (let x = 0; x < outW; x++) {
      let s0 = ONE / 2, s1 = s0, s2 = s0, s3 = s0;
      for (let t = 0; t < n; t++) { const q = ((lo + t) * outW + x) * 4, w = kk[t]!; s0 += mid[q]! * w; s1 += mid[q + 1]! * w; s2 += mid[q + 2]! * w; s3 += mid[q + 3]! * w; }
      const o = (yy * outW + x) * 4; let r = clip8(s0), g = clip8(s1), b = clip8(s2); const a = clip8(s3);
      if (alpha && a > 0 && a < 255) { r = Math.min(255, Math.floor((255 * r) / a)); g = Math.min(255, Math.floor((255 * g) / a)); b = Math.min(255, Math.floor((255 * b) / a)); }   // RGBa -> RGBA
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = alpha ? a : 255;
    }
  }
  return { w: outW, h: outH, data: out };
}

/** ImageOps.fit(im, (w, h), filter): recorta no centro para a proporção e reamostra com a caixa (cobre a área toda). */
export function pilFit(src: Raster, w: number, h: number, filter: Filter, alpha = false): Raster {
  const ratio = w / h, live = src.w / src.h;
  const cw = live >= ratio ? ratio * src.h : src.w, ch = live >= ratio ? src.h : src.w / ratio;
  const left = (src.w - cw) * 0.5, top = (src.h - ch) * 0.5;
  return pilResize(src, w, h, filter, alpha, [left, top, left + cw, top + ch]);
}

/** Imagem inteira dentro de w x h, sem recortar: mantém a proporção, centraliza e completa com o fundo escuro do botão (GIFs enviados). */
export function fitInside(src: Raster, w: number, h: number): Raster {
  const k = Math.min(w / src.w, h / src.h), nw = Math.max(1, Math.round(src.w * k)), nh = Math.max(1, Math.round(src.h * k));
  const sc = pilResize(src, nw, nh, 'bicubic', true), out = new Uint8ClampedArray(w * h * 4), x0 = Math.trunc((w - nw) / 2), y0 = Math.trunc((h - nh) / 2);
  for (let q = 0; q < out.length; q += 4) { out[q] = 22; out[q + 1] = 22; out[q + 2] = 26; out[q + 3] = 255; }
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const a = (y * nw + x) * 4, o = ((y0 + y) * w + x0 + x) * 4, al = sc.data[a + 3]! / 255;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(sc.data[a + c]! * al + out[o + c]! * (1 - al));
  }
  return { w, h, data: out };
}
