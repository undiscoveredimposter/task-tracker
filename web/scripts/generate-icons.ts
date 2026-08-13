/**
 * Writes the app icons into `public/`. Run with `npm run icons -w @tally/web`
 * after changing anything in `icon.ts`; `icon.test.ts` fails if the committed
 * files and the mark have drifted apart.
 */

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { ICON_FILES, encodePng, rasterise } from './icon.ts';

for (const { file, size, mark } of ICON_FILES) {
  const png = encodePng(size, rasterise(mark, size), (data) => deflateSync(data, { level: 9 }));
  writeFileSync(new URL(`../public/${file}`, import.meta.url), png);
  console.log(`${file}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} kB`);
}
