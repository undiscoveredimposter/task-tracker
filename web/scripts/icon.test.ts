import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  APPLE_MARK,
  CHECK,
  DESIGN_SIZE,
  GROUND,
  ICON_FILES,
  MASKABLE_MARK,
  ROUNDED_MARK,
  crc32,
  encodePng,
  hexToRgb,
  rasterise,
  type Mark,
  type Point,
} from './icon.ts';

const deflate = (data: Uint8Array) => deflateSync(data, { level: 9 });

/** Reads back what `encodePng` wrote: chunk list plus the raw RGBA it carried. */
function decodePng(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Uint8Array; crcValid: boolean }[] = [];

  let at = 8; // past the signature
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    const declared = view.getUint32(at + 8 + length);
    chunks.push({ type, data, crcValid: crc32(png.subarray(at + 4, at + 8 + length)) === declared });
    at += 12 + length;
  }

  const ihdr = chunks.find((c) => c.type === 'IHDR')!;
  const header = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = header.getUint32(0);
  const height = header.getUint32(4);

  const idat = chunks.filter((c) => c.type === 'IDAT').flatMap((c) => [...c.data]);
  const raw = inflateSync(Uint8Array.from(idat));

  // Every scanline is written with filter type 0, so undoing it is just
  // dropping the leading filter byte from each row.
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = y * (width * 4 + 1);
    expect(raw[from]).toBe(0);
    rgba.set(raw.subarray(from + 1, from + 1 + width * 4), y * width * 4);
  }

  return { chunks, width, height, rgba, bitDepth: ihdr.data[8], colorType: ihdr.data[9] };
}

const pixelAt = (rgba: Uint8Array, size: number, x: number, y: number) =>
  [...rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

/** Design-space point → the pixel that contains it at a given output size. */
const toPixel = (designUnits: number, size: number) =>
  Math.floor((designUnits * size) / DESIGN_SIZE);

const publicFile = (name: string) => new URL(`../public/${name}`, import.meta.url);

describe('crc32', () => {
  it('matches the known CRC of "IEND"', () => {
    // The IEND chunk is a fixed sequence, so its CRC is a published constant —
    // a wrong table shows up here rather than as an unopenable file.
    expect(crc32(new Uint8Array([0x49, 0x45, 0x4e, 0x44]))>>> 0).toBe(0xae426082);
  });
});

describe('encodePng', () => {
  const rgba = rasterise(ROUNDED_MARK, 16);
  const png = encodePng(16, rgba, deflate);

  it('opens with the PNG signature', () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('declares an 8-bit RGBA image of the size it was given', () => {
    const decoded = decodePng(png);
    expect(decoded.width).toBe(16);
    expect(decoded.height).toBe(16);
    expect(decoded.bitDepth).toBe(8);
    expect(decoded.colorType).toBe(6);
  });

  it('writes IHDR first and IEND last', () => {
    const types = decodePng(png).chunks.map((c) => c.type);
    expect(types[0]).toBe('IHDR');
    expect(types.at(-1)).toBe('IEND');
  });

  it('gives every chunk a valid CRC', () => {
    expect(decodePng(png).chunks.every((c) => c.crcValid)).toBe(true);
  });

  it('round-trips the exact pixels it was handed', () => {
    expect([...decodePng(png).rgba]).toEqual([...rgba]);
  });
});

describe('rasterise', () => {
  it('returns RGBA for every pixel', () => {
    expect(rasterise(ROUNDED_MARK, 32)).toHaveLength(32 * 32 * 4);
  });

  it('leaves the corners of the rounded mark transparent', () => {
    const rgba = rasterise(ROUNDED_MARK, 512);
    for (const [x, y] of [
      [0, 0],
      [511, 0],
      [0, 511],
      [511, 511],
    ] as const) {
      expect(pixelAt(rgba, 512, x, y)[3]).toBe(0);
    }
  });

  it('paints the corners of a full-bleed mark solid', () => {
    // iOS composites any transparency in an apple-touch-icon onto black and
    // then applies its own corner mask, so the source must be a full square.
    const rgba = rasterise(APPLE_MARK, 180);
    expect(pixelAt(rgba, 180, 0, 0)).toEqual([...hexToRgb(GROUND), 255]);
    expect(pixelAt(rgba, 180, 179, 179)).toEqual([...hexToRgb(GROUND), 255]);
  });

  it('strokes the check in the check colour', () => {
    const rgba = rasterise(ROUNDED_MARK, 512);
    const [vx, vy] = ROUNDED_MARK.points[1]!;
    expect(pixelAt(rgba, 512, toPixel(vx, 512), toPixel(vy, 512))).toEqual([
      ...hexToRgb(CHECK),
      255,
    ]);
  });

  it('shows the ground away from the check', () => {
    const rgba = rasterise(ROUNDED_MARK, 512);
    expect(pixelAt(rgba, 512, 60, 60)).toEqual([...hexToRgb(GROUND), 255]);
  });

  it('renders the same bytes every run', () => {
    expect([...rasterise(MASKABLE_MARK, 64)]).toEqual([...rasterise(MASKABLE_MARK, 64)]);
  });
});

/** Pixels whose colour has been touched by the check rather than pure ground. */
function checkPixels(mark: Mark, size: number) {
  const rgba = rasterise(mark, size);
  const ground = hexToRgb(GROUND);
  const found: { x: number; y: number }[] = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(rgba, size, x, y);
      if (r !== ground[0] || g !== ground[1] || b !== ground[2]) found.push({ x, y });
    }
  }
  return found;
}

describe('the maskable mark', () => {
  const size = 512;
  const painted = checkPixels(MASKABLE_MARK, size);

  it('actually draws a check', () => {
    expect(painted.length).toBeGreaterThan(0);
  });

  it('keeps every painted pixel inside the 80% safe circle', () => {
    // Launchers may crop a maskable icon to a circle of 80% of its width.
    // Anything outside that radius is liable to lose a limb of the check.
    const centre = size / 2;
    const safeRadius = size * 0.4;

    const furthest = painted.reduce(
      (worst, p) => Math.max(worst, Math.hypot(p.x + 0.5 - centre, p.y + 0.5 - centre)),
      0,
    );
    expect(furthest).toBeLessThan(safeRadius);
  });

  it('is full-bleed, so a launcher has ground to crop into', () => {
    expect(MASKABLE_MARK.cornerRadius).toBe(0);
  });
});

/** Enough of an SVG reader for the two files the mark is authored in. */
function readSvgMark(file: string) {
  const svg = readFileSync(publicFile(file), 'utf8');
  const attr = (tag: string, name: string) =>
    new RegExp(`<${tag}[^>]*\\b${name}="([^"]+)"`).exec(svg)?.[1];

  const points: Point[] = [];
  let x = 0;
  let y = 0;
  for (const command of attr('path', 'd')!.match(/[MmLl][^MmLl]*/g) ?? []) {
    const [dx, dy] = command.slice(1).trim().split(/[\s,]+/).map(Number) as [number, number];
    const relative = command[0] === command[0]!.toLowerCase();
    x = relative ? x + dx : dx;
    y = relative ? y + dy : dy;
    points.push([x, y]);
  }

  return {
    mark: {
      cornerRadius: Number(attr('rect', 'rx') ?? 0),
      points,
      strokeWidth: Number(attr('path', 'stroke-width')),
    },
    ground: attr('rect', 'fill'),
    check: attr('path', 'stroke'),
  };
}

describe.each([
  { file: 'icon.svg', mark: ROUNDED_MARK },
  { file: 'icon-maskable.svg', mark: MASKABLE_MARK },
])('$file', ({ file, mark }) => {
  it('is the same drawing the PNGs are rendered from', () => {
    // The manifest ships the SVG and the PNG side by side, so the two must not
    // be allowed to become different pictures.
    const svg = readSvgMark(file);
    expect(svg.mark.cornerRadius).toBe(mark.cornerRadius);
    expect(svg.mark.strokeWidth).toBe(mark.strokeWidth);
    expect(svg.ground).toBe(GROUND);
    expect(svg.check).toBe(CHECK);

    // Coordinates are compared loosely: the SVG walks the check in relative
    // steps, so it lands a float's-breadth away from the absolute points here.
    expect(svg.mark.points).toHaveLength(mark.points.length);
    svg.mark.points.forEach(([x, y], i) => {
      const [ax, ay] = mark.points[i]!;
      expect(x).toBeCloseTo(ax, 6);
      expect(y).toBeCloseTo(ay, 6);
    });
  });
});

describe('the committed icons', () => {
  it.each(ICON_FILES)('$file matches what the generator renders today', ({ file, size, mark }) => {
    // Guards against the PNGs drifting from the mark: change icon.ts without
    // rerunning `npm run icons -w @tally/web` and this fails.
    const committed = decodePng(new Uint8Array(readFileSync(publicFile(file))));
    expect(committed.width).toBe(size);
    expect(committed.height).toBe(size);

    // Counted rather than deep-equalled: a byte-by-byte diff of a 512px icon is
    // a million-entry failure message nobody can read.
    const expected = rasterise(mark, size);
    let differing = 0;
    for (let i = 0; i < expected.length; i++) if (committed.rgba[i] !== expected[i]) differing++;
    expect(differing).toBe(0);
  });
});
