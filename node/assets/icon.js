// Salva o ícone de um .app (como o Finder mostra) em PNG.  Uso: osascript -l JavaScript icon.js /Applications/X.app saida.png
ObjC.import('AppKit');
function run(argv) {
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  img.setSize($.NSMakeSize(256, 256));
  const rep = $.NSBitmapImageRep.alloc.initWithData(img.TIFFRepresentation);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  png.writeToFileAtomically(argv[1], true);
  return 'ok';
}
