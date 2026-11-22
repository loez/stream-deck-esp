// Gera o pacote local de ícones (node/assets/icones/) a partir dos pacotes npm `lucide-static` (ISC) e `simple-icons` (CC0).
// Uso (só quando quiser atualizar o pacote; o resultado é commitado, o servidor nunca baixa nada):
//   mkdir /tmp/pk && cd /tmp/pk && npm init -y && npm i lucide-static simple-icons
//   node tools/gerar-icones.mjs /tmp/pk/node_modules
// Saída: lucide.json {slug: [[tag,{attrs}]...]} · simple.json {slug: [titulo, hexDaMarca, d]} · index.json (busca/categorias) · LICENSES/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NM = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(NM, 'lucide-static'))) { console.error('uso: node tools/gerar-icones.mjs <pasta node_modules com lucide-static e simple-icons>'); process.exit(1); }
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icones');
fs.mkdirSync(path.join(OUT, 'LICENSES'), { recursive: true });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const ver = (p) => readJson(path.join(NM, p, 'package.json')).version;

// Categorias (nome em português = chave de tradução). Um ícone entra na categoria se o nome ou alguma palavra-chave dele bate com uma destas palavras.
const CATS = [
  ['midia', 'Mídia e som', 'play pause stop music audio volume speaker headphones microphone mic video film camera radio podcast record skip rewind forward shuffle repeat playlist disc vinyl tv cast'],
  ['setas', 'Setas e navegação', 'arrow arrows chevron chevrons direction navigation compass map pin route corner move undo redo refresh rotate'],
  ['casa', 'Casa e automação', 'home house door window lamp light bulb lightbulb bed sofa couch lock key thermometer fan plug power outlet switch toggle heater air blinds curtain garage'],
  ['dispositivos', 'Dispositivos e tecnologia', 'computer laptop monitor phone smartphone tablet keyboard mouse cpu chip server database hard-drive usb bluetooth wifi network router printer battery gamepad watch device'],
  ['comunicacao', 'Comunicação', 'message mail email chat comment phone call send inbox bell notification share at megaphone'],
  ['arquivos', 'Arquivos e pastas', 'file files folder document archive download upload save copy paste clipboard cut trash bin attachment paperclip zip'],
  ['texto', 'Texto e edição', 'text type font bold italic underline heading list align quote code pen pencil edit brush paint eraser highlighter table'],
  ['dev', 'Código e desenvolvimento', 'code terminal command git branch bug braces brackets console cli package container webhook api server cloud binary'],
  ['tempo', 'Tempo e calendário', 'clock time timer alarm calendar date hourglass watch schedule history stopwatch'],
  ['natureza', 'Natureza e clima', 'sun moon cloud rain snow wind storm lightning leaf tree flower plant mountain water droplet fire flame earth globe waves umbrella star sunrise sunset'],
  ['transporte', 'Transporte e viagem', 'car bus train plane airplane bike bicycle truck ship boat rocket fuel parking traffic luggage ticket tent'],
  ['comida', 'Comida e bebida', 'coffee cup beer wine pizza burger cake apple utensils food drink cookie ice-cream soup salad egg candy martini milk bottle'],
  ['dinheiro', 'Dinheiro e compras', 'dollar euro bitcoin coin coins wallet credit-card banknote bank shopping cart bag store tag receipt piggy percent price'],
  ['pessoas', 'Pessoas e social', 'user users person people contact heart thumbs smile frown face hand baby accessibility handshake'],
  ['saude', 'Saúde e esporte', 'heart pulse stethoscope pill syringe hospital cross activity dumbbell trophy medal bandage thermometer microscope dna flask'],
  ['jogos', 'Jogos e diversão', 'gamepad dices dice puzzle sword shield ghost crown joystick swords drama party gift balloon sparkles wand'],
  ['ferramentas', 'Ferramentas e ajustes', 'settings cog gear wrench hammer screwdriver tool tools sliders filter search zoom ruler scissors magnet axe pickaxe construction'],
  ['formas', 'Formas e símbolos', 'circle square triangle hexagon octagon diamond check x plus minus info alert warning help question ban slash flag bookmark shield badge infinity hash asterisk'],
  ['seguranca', 'Segurança', 'lock unlock key shield security fingerprint eye scan password siren cctv'],
];

// Português -> palavras em inglês das palavras-chave (para buscar "casa" e achar "house"/"home"). Vale só para a busca da página.
const PT = {
  casa: 'home house', lar: 'home', porta: 'door', janela: 'window', lampada: 'lamp lightbulb light bulb', luz: 'light lamp', cama: 'bed', sofa: 'sofa couch', chave: 'key wrench', trancar: 'lock', cadeado: 'lock padlock',
  musica: 'music audio', som: 'audio volume speaker', volume: 'volume', mudo: 'mute volume-x', fone: 'headphones', microfone: 'microphone mic', video: 'video film', camera: 'camera', foto: 'camera image photo', imagem: 'image picture', tv: 'tv monitor',
  tocar: 'play', pausar: 'pause', parar: 'stop', proxima: 'skip-forward next', anterior: 'skip-back previous', aleatorio: 'shuffle', repetir: 'repeat', gravar: 'record', radio: 'radio',
  seta: 'arrow', setas: 'arrow', cima: 'up', baixo: 'down', esquerda: 'left', direita: 'right', voltar: 'back undo', avancar: 'forward redo', atualizar: 'refresh rotate', recarregar: 'refresh rotate',
  computador: 'computer laptop monitor', notebook: 'laptop', celular: 'smartphone phone', telefone: 'phone', teclado: 'keyboard', mouse: 'mouse', impressora: 'printer', bateria: 'battery', tomada: 'plug outlet power', ligar: 'power', desligar: 'power', energia: 'power zap',
  mensagem: 'message', email: 'mail', correio: 'mail', conversa: 'chat message', sino: 'bell', notificacao: 'bell notification', enviar: 'send', compartilhar: 'share',
  arquivo: 'file', arquivos: 'files', pasta: 'folder', documento: 'document file', baixar: 'download', salvar: 'save', copiar: 'copy', colar: 'paste clipboard', lixeira: 'trash', apagar: 'trash delete', excluir: 'trash delete', anexo: 'paperclip attachment',
  texto: 'text', fonte: 'font type', negrito: 'bold', italico: 'italic', lista: 'list', codigo: 'code', terminal: 'terminal', bug: 'bug', nuvem: 'cloud', servidor: 'server', banco: 'database bank', dados: 'database',
  relogio: 'clock watch', hora: 'clock time', tempo: 'time clock', cronometro: 'timer stopwatch', alarme: 'alarm', calendario: 'calendar', data: 'calendar date',
  sol: 'sun', lua: 'moon', chuva: 'rain cloud-rain', neve: 'snow', vento: 'wind', raio: 'zap lightning', tempestade: 'storm', folha: 'leaf', arvore: 'tree', flor: 'flower', planta: 'plant sprout', montanha: 'mountain', agua: 'water droplet', gota: 'droplet', fogo: 'flame fire', terra: 'earth globe', mundo: 'globe earth', estrela: 'star', temperatura: 'thermometer',
  carro: 'car', onibus: 'bus', trem: 'train', aviao: 'plane airplane', bicicleta: 'bike bicycle', caminhao: 'truck', navio: 'ship', barco: 'boat', foguete: 'rocket', combustivel: 'fuel', estacionamento: 'parking', mala: 'luggage', viagem: 'plane luggage', mapa: 'map', localizacao: 'map-pin', gps: 'navigation map-pin',
  cafe: 'coffee', cerveja: 'beer', vinho: 'wine', comida: 'utensils food', pizza: 'pizza', hamburguer: 'burger sandwich', bolo: 'cake', maca: 'apple', bebida: 'cup-soda wine beer martini',
  dinheiro: 'dollar banknote coin coins', moeda: 'coin coins', carteira: 'wallet', cartao: 'credit-card', compras: 'shopping-cart shopping-bag', carrinho: 'shopping-cart', loja: 'store', sacola: 'shopping-bag', preco: 'tag',
  usuario: 'user', pessoa: 'user', pessoas: 'users', amigos: 'users', coracao: 'heart', curtir: 'thumbs-up heart', sorriso: 'smile', rosto: 'smile face', mao: 'hand', bebe: 'baby',
  saude: 'heart-pulse stethoscope', remedio: 'pill', hospital: 'hospital', academia: 'dumbbell', esporte: 'trophy dumbbell', trofeu: 'trophy', medalha: 'medal',
  jogo: 'gamepad dices', jogos: 'gamepad dices', controle: 'gamepad', dado: 'dice', quebra: 'puzzle', espada: 'sword', escudo: 'shield', fantasma: 'ghost', coroa: 'crown', presente: 'gift', festa: 'party-popper', balao: 'balloon',
  configuracao: 'settings cog', configuracoes: 'settings cog', ajustes: 'settings sliders', engrenagem: 'cog settings', ferramenta: 'wrench hammer', martelo: 'hammer', chave_de_fenda: 'screwdriver', filtro: 'filter', buscar: 'search', procurar: 'search', lupa: 'search zoom', tesoura: 'scissors', regua: 'ruler', ima: 'magnet',
  circulo: 'circle', quadrado: 'square', triangulo: 'triangle', certo: 'check', ok: 'check', errado: 'x', fechar: 'x', mais: 'plus', menos: 'minus', aviso: 'alert triangle warning', alerta: 'alert warning', ajuda: 'help question', pergunta: 'question', informacao: 'info', bandeira: 'flag', favorito: 'star bookmark heart', marcador: 'bookmark',
  seguranca: 'shield lock security', senha: 'key lock password', digital: 'fingerprint', olho: 'eye', ver: 'eye', esconder: 'eye-off', visivel: 'eye',
  wifi: 'wifi', rede: 'network wifi', bluetooth: 'bluetooth', usb: 'usb', jogo_de_cartas: 'spade', robo: 'bot', inteligencia: 'brain sparkles bot', magia: 'wand sparkles', brilho: 'sparkles sun', cor: 'palette paint', pintar: 'paintbrush paint', desenhar: 'pencil pen', editar: 'pencil edit', livro: 'book', ler: 'book', escola: 'graduation-cap', ideia: 'lightbulb', alvo: 'target', grafico: 'chart bar', pizza_grafico: 'pie-chart', ventilador: 'fan', ar: 'wind air', aquecedor: 'heater', cortina: 'blinds', garagem: 'warehouse', jardim: 'flower sprout', pet: 'paw-print dog cat', cachorro: 'dog', gato: 'cat', passaro: 'bird', peixe: 'fish',
};

// ---- Lucide ----
const lucideNodes = readJson(path.join(NM, 'lucide-static', 'icon-nodes.json'));
const lucideTags = readJson(path.join(NM, 'lucide-static', 'tags.json'));
const lucide = {};
const items = [];   // [id, nome, categorias, palavras]
const catOf = (name, tags) => {
  const words = new Set([...name.split('-'), name, ...tags.flatMap((t) => [t.toLowerCase(), ...t.toLowerCase().split(/[\s-]+/)])]);
  return CATS.filter(([, , kw]) => kw.split(' ').some((k) => words.has(k))).map(([id]) => id);
};
for (const [slug, nodes] of Object.entries(lucideNodes)) {
  lucide[slug] = nodes.map(([tag, attrs]) => [tag, attrs]);
  const tags = lucideTags[slug] || [];
  items.push(['l', slug, catOf(slug, tags).join(','), tags.join(' ').toLowerCase()]);
}
fs.writeFileSync(path.join(OUT, 'lucide.json'), JSON.stringify(lucide));

// ---- Simple Icons (logos de marcas) ----
const simpleList = readJson(path.join(NM, 'simple-icons', 'data', 'simple-icons.json'));
const simple = {};
for (const e of simpleList) {
  const f = path.join(NM, 'simple-icons', 'icons', `${e.slug}.svg`); if (!fs.existsSync(f)) continue;
  const d = /<path d="([^"]+)"/.exec(fs.readFileSync(f, 'utf8'))?.[1]; if (!d) continue;
  simple[e.slug] = [e.title, e.hex, d];
  items.push(['s', e.slug, '', `${e.title.toLowerCase()} ${((e.aliases && e.aliases.aka) || []).join(' ').toLowerCase()}`]);
}
fs.writeFileSync(path.join(OUT, 'simple.json'), JSON.stringify(simple));

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pt = {}; for (const [k, v] of Object.entries(PT)) pt[strip(k).replace(/_/g, ' ')] = v;
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ lucide: ver('lucide-static'), simple: ver('simple-icons'), cats: CATS.map(([id, n]) => [id, n]), pt, brand: Object.fromEntries(Object.entries(simple).map(([k, v]) => [k, v[1]])), items }));

// ---- licenças (precisam acompanhar a redistribuição) ----
fs.copyFileSync(path.join(NM, 'lucide-static', 'LICENSE'), path.join(OUT, 'LICENSES', 'LUCIDE-LICENSE.txt'));
fs.copyFileSync(path.join(NM, 'simple-icons', 'LICENSE.md'), path.join(OUT, 'LICENSES', 'SIMPLE-ICONS-LICENSE.md'));
fs.writeFileSync(path.join(OUT, 'LEIA-ME.md'), `# Pacote de ícones (local, sem internet)

- **Lucide** v${ver('lucide-static')} (${Object.keys(lucide).length} ícones de interface, licença ISC) — \`lucide.json\`.
- **Simple Icons** v${ver('simple-icons')} (${Object.keys(simple).length} logos de marcas, CC0) — \`simple.json\`. Logos são marcas registradas dos seus donos; o uso é por conta do usuário.
- \`index.json\`: nomes, palavras-chave, categorias e dicionário português→inglês da busca.
- Licenças completas em \`LICENSES/\`. Para atualizar: \`node tools/gerar-icones.mjs <node_modules>\` (ver o início do script).
`);
console.log(`lucide ${Object.keys(lucide).length} · simple ${Object.keys(simple).length}`);
const miss = CATS.map(([id]) => [id, items.filter((i) => i[2].split(',').includes(id)).length]); console.log(miss.map((m) => m.join(':')).join(' '));
console.log('sem categoria (lucide):', items.filter((i) => i[0] === 'l' && !i[2]).length);
