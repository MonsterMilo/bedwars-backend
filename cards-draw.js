// --- Drawing a card: layout tree -> PNG ---
// satori lays the tree out and gives an SVG; resvg turns that into a PNG.
// Both are heavy, synchronous work (around a second on Render's free CPU),
// so cards.js runs this in a worker thread (card-worker.js) and the main
// thread stays free to answer requests and Discord clicks meanwhile.

const fs = require('fs');
const path = require('path');

// --- Fonts (all from Google Fonts, SIL Open Font License; DejaVu for symbols) ---
const FONT_DIR = path.join(__dirname, 'fonts');
const font = (name, file, weight = 400) => ({ name, data: fs.readFileSync(path.join(FONT_DIR, file)), weight, style: 'normal' });
let FONTS = null; // read on the first card, so a thread that never draws doesn't load them
const loadFonts = () => [
  font('Jersey', 'Jersey10.ttf'),
  font('Silkscreen', 'Silkscreen-400.ttf', 400), font('Silkscreen', 'Silkscreen-700.ttf', 700),
  font('Manrope', 'Manrope-500.ttf', 500), font('Manrope', 'Manrope-700.ttf', 700), font('Manrope', 'Manrope-800.ttf', 800),
  font('Anton', 'Anton.ttf'),
  font('Courier Prime', 'CourierPrime-400.ttf', 400), font('Courier Prime', 'CourierPrime-700.ttf', 700),
  font('Caveat', 'Caveat-700.ttf', 700),
  font('Playfair', 'PlayfairDisplay-700.ttf', 700),
  font('Garamond', 'EBGaramond-500.ttf', 500), font('Garamond', 'EBGaramond-700.ttf', 700),
  font('Chakra', 'ChakraPetch-600.ttf', 600), font('Chakra', 'ChakraPetch-700.ttf', 700),
  font('Sora', 'Sora-500.ttf', 500), font('Sora', 'Sora-700.ttf', 700),
  // Harvest: Ultra (wood type), Stardos Stencil (crate stamps), Bitter, Kalam (handwriting).
  font('Ultra', 'Ultra.ttf'),
  font('Stencil', 'StardosStencil-700.ttf', 700),
  font('Bitter', 'Bitter-500.ttf', 500), font('Bitter', 'Bitter-700.ttf', 700),
  font('Kalam', 'Kalam-700.ttf', 700),
  // ✫ ✪ ⚑ ⚠ and other symbols the theme fonts don't have.
  font('Symbols', 'DejaVuSans-Bold.ttf', 700)
];

let satori = null;
let Resvg = null;
// width: the layout width; outWidth: the PNG's width.
async function draw(tree, width, outWidth) {
  if (!satori) {
    FONTS = loadFonts();
    satori = require('satori').default;
    ({ Resvg } = require('@resvg/resvg-js'));
  }
  const svg = await satori(tree, { width, fonts: FONTS });
  return new Resvg(svg, { fitTo: { mode: 'width', value: outWidth } }).render().asPng();
}

module.exports = { draw };
