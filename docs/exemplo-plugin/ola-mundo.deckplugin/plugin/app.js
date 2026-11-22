// Plugin de exemplo com o SDK do projeto (deck-plugin.mjs): sem dependências, o app roda este arquivo com `node plugin/app.js 127.0.0.1 <porta>`.
import zlib from 'node:zlib';
import { Plugin } from './deck-plugin.mjs';

// PNG de cor sólida 144x144 (sem biblioteca de imagem): assinatura + IHDR + IDAT (zlib) + IEND
function pngSolido(r, g, b) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const bloco = (tipo, dados) => { const t = Buffer.from(tipo), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(dados.length); c.writeUInt32BE(crc(Buffer.concat([t, dados]))); return Buffer.concat([l, t, dados, c]); };
  const W = 144, linha = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: W }, () => [r, g, b]).flat())]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloco('IHDR', ihdr), bloco('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: W }, () => linha)))), bloco('IEND', Buffer.alloc(0))]);
}
const CORES = { vermelho: [220, 50, 50], verde: [40, 170, 90], azul: [50, 110, 220] };

function desenhar(b) {   // ícone (PNG em Buffer) + texto que o app desenha por cima (só aparece se o usuário marcar "mostrar texto do plugin")
  const cor = CORES[b.settings.cor] || CORES.azul;
  b.set({ image: pngSolido(...cor), text: `${b.settings.titulo || 'Toques'}\n${b.state.toques || 0}` });
}

const plugin = new Plugin();   // endereço/porta: argumentos do processo; id: plugin.json
plugin.action('contador', {
  onAdd: desenhar,                                                               // botão atribuído (ou página carregada)
  onPress: (b) => { b.state.toques = (b.state.toques || 0) + 1; desenhar(b); b.toast(`Toques: ${b.state.toques}`); },
  onSettings: desenhar,                                                          // a configuração mudou (tela de configuração salvou)
});
