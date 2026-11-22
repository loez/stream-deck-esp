// Tipos mínimos do omggif (decodificador/gerador de GIF, MIT) usados em anim.ts e nos testes.
declare module 'omggif' {
  export type FrameInfo = { x: number; y: number; width: number; height: number; has_local_palette: boolean; palette_offset: number | null; palette_size: number | null; data_offset: number; data_length: number; transparent_index: number | null; interlaced: boolean; delay: number; disposal: number };
  export class GifReader {
    constructor(buf: Uint8Array);
    width: number; height: number;
    numFrames(): number; loopCount(): number | null;
    frameInfo(i: number): FrameInfo;
    decodeAndBlitFrameRGBA(i: number, pixels: Uint8Array | Uint8ClampedArray): void;
  }
  export class GifWriter {
    constructor(buf: Uint8Array, width: number, height: number, opts?: { palette?: number[]; loop?: number });
    addFrame(x: number, y: number, w: number, h: number, indexed: Uint8Array | number[], opts?: { palette?: number[]; delay?: number; disposal?: number; transparent?: number }): number;
    end(): number;
  }
}
