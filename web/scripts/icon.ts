/**
 * The Tally mark, drawn from its geometry rather than traced from a file, so the
 * PNGs the stores and iOS need can be regenerated from source instead of being
 * committed as opaque binaries nobody can edit. See `generate-icons.ts`.
 *
 * Everything here is deliberately free of Node built-ins — the caller injects
 * deflate — which keeps the whole thing testable as plain logic.
 */

export const GROUND = '#161826';
export const CHECK = '#9184d9';

/** The mark is authored at 512 units square and scaled down to each output. */
export const DESIGN_SIZE = 512;

export type Point = readonly [number, number];

export type Mark = {
  /** Ground corner radius in design units. 0 is full-bleed. */
  cornerRadius: number;
  /** The check, as a polyline stroked with round caps and joins. */
  points: readonly Point[];
  strokeWidth: number;
};

/** `public/icon.svg` — the mark as designed, rounding its own corners. */
export const ROUNDED_MARK: Mark = {
  cornerRadius: 113,
  points: [
    [128, 266.24],
    [209.92, 348.16],
    [363.52, 174.08],
  ],
  strokeWidth: 43.52,
};

/** `public/icon-maskable.svg` — smaller check, full bleed, safe under a crop. */
export const MASKABLE_MARK: Mark = {
  cornerRadius: 0,
  points: [
    [170, 270],
    [222, 322],
    [322, 210],
  ],
  strokeWidth: 44,
};

/**
 * iOS masks an apple-touch-icon into its own squircle and fills any alpha with
 * black. Rounding our corners as well would show as a dark seam inside Apple's
 * curve, so this is the designed check on a square ground.
 */
export const APPLE_MARK: Mark = { ...ROUNDED_MARK, cornerRadius: 0 };

export const ICON_FILES = [
  { file: 'icon-192.png', size: 192, mark: ROUNDED_MARK },
  { file: 'icon-512.png', size: 512, mark: ROUNDED_MARK },
  { file: 'icon-maskable-512.png', size: 512, mark: MASKABLE_MARK },
  { file: 'apple-touch-icon.png', size: 180, mark: APPLE_MARK },
] as const satisfies readonly { file: string; size: number; mark: Mark }[];

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Signed distance to a rounded square centred in the design box. */
function groundDistance(x: number, y: number, radius: number): number {
  const half = DESIGN_SIZE / 2;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

/**
 * Signed distance to the stroked polyline. Taking the minimum over each segment
 * is what gives round joins for free: the caps of neighbouring segments overlap
 * at the shared point.
 */
function checkDistance(x: number, y: number, mark: Mark): number {
  let nearest = Infinity;

  for (let i = 1; i < mark.points.length; i++) {
    const [ax, ay] = mark.points[i - 1]!;
    const [bx, by] = mark.points[i]!;
    const bax = bx - ax;
    const bay = by - ay;
    const pax = x - ax;
    const pay = y - ay;
    const length2 = bax * bax + bay * bay;
    const along = length2 === 0 ? 0 : Math.min(1, Math.max(0, (pax * bax + pay * bay) / length2));
    nearest = Math.min(nearest, Math.hypot(pax - bax * along, pay - bay * along));
  }

  return nearest - mark.strokeWidth / 2;
}

/**
 * Antialiased coverage of one pixel. A signed distance carries straight over to
 * area for the shapes here, so a half-pixel band around the edge is enough and
 * costs none of the noise supersampling would add.
 */
const coverage = (distance: number, pixelsPerUnit: number) =>
  Math.min(1, Math.max(0, 0.5 - distance * pixelsPerUnit));

/** Draws a mark at `size` square, as straight (non-premultiplied) RGBA bytes. */
export function rasterise(mark: Mark, size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const scale = size / DESIGN_SIZE;
  const ground = hexToRgb(GROUND);
  const check = hexToRgb(CHECK);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / scale;
      const dy = (y + 0.5) / scale;

      const onCheck = coverage(checkDistance(dx, dy, mark), scale);
      const onGround = coverage(groundDistance(dx, dy, mark.cornerRadius), scale);

      const behind = onGround * (1 - onCheck);
      const alpha = onCheck + behind;
      const at = (y * size + x) * 4;

      if (alpha > 0) {
        for (let c = 0; c < 3; c++) {
          rgba[at + c] = Math.round((check[c]! * onCheck + ground[c]! * behind) / alpha);
        }
      }
      rgba[at + 3] = Math.round(alpha * 255);
    }
  }

  return rgba;
}

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type Deflate = (data: Uint8Array) => Uint8Array;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);

  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

/**
 * Minimal PNG writer: 8-bit RGBA, no interlacing, and filter type 0 on every
 * scanline. Fancier filters would shave a few hundred bytes off a flat-colour
 * icon and cost far more to read.
 */
export function encodePng(size: number, rgba: Uint8Array, deflate: Deflate): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  // bytes 10-12 stay 0: deflate, adaptive filtering, no interlace

  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];

  const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}
