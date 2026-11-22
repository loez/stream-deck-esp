// Envia uma tecla de mídia do sistema (play/pausa, próxima, volume...).  Uso: osascript -l JavaScript media.js playpause
// Usa eventos "system defined" do HID, como as teclas físicas do teclado. Pode exigir a permissão de Acessibilidade.
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
const KEYS = { volup: 0, voldown: 1, brightup: 2, brightdown: 3, mute: 7, playpause: 16, next: 17, prev: 18 };
function run(argv) {
  if (!$.AXIsProcessTrusted()) throw new Error('assistive access not allowed (1002)');   // o envio de eventos falha em silêncio sem a permissão
  const k = KEYS[argv[0]];
  if (k === undefined) throw new Error('tecla de midia desconhecida: ' + argv[0]);
  for (const down of [true, false]) {
    const ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
      14, $.NSMakePoint(0, 0), down ? 0xa00 : 0xb00, 0, 0, $(), 8, (k << 16) | ((down ? 0xa : 0xb) << 8), -1);
    $.CGEventPost(0, ev.CGEvent);
  }
  return 'ok';
}
