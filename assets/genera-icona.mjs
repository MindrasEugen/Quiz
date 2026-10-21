import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve('@capacitor/assets/package.json'))('sharp');
const out = fileURLToPath(new URL('./', import.meta.url));
// Marchio: Q serif bianca e freccia lime, come il logo nella barra del sito. Contenuto entro la zona sicura delle icone adattive.
const mark = (s = 1, dx = 0, dy = 0) => `<g transform="translate(${dx} ${dy}) scale(${s})">
  <text x="452" y="664" font-family="Georgia, 'Times New Roman', serif" font-size="500" fill="#ffffff" text-anchor="middle">Q</text>
  <g stroke="#e2eead" stroke-width="46" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <line x1="652" y1="772" x2="778" y2="646"/><polyline points="690,646 778,646 778,734"/>
  </g></g>`;
const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
const write = (name, w, h, body) => sharp(svg(w, h, body)).png().toFile(out + name);
await write('icon-background.png', 1024, 1024, '<rect width="1024" height="1024" fill="#254b40"/>');
await write('icon-foreground.png', 1024, 1024, mark());
await write('icon-only.png', 1024, 1024, '<rect width="1024" height="1024" fill="#254b40"/>' + mark());
const splash = bg => `<rect width="2732" height="2732" fill="${bg}"/><rect x="1066" y="1066" width="600" height="600" rx="132" fill="#254b40"/>` + mark(600 / 1024, 1066, 1066);
await write('splash.png', 2732, 2732, splash('#f6f5f0'));
await write('splash-dark.png', 2732, 2732, splash('#1f3631'));
console.log('ok');
