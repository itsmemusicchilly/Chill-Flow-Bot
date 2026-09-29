// Small image fixtures built on the fly (no binary files in the repo).
import zlib from 'node:zlib';
import sharp from 'sharp';

export const SECRET = 'secret-camera-owner';

/** A plain PNG, optionally with a see-through corner. */
export const png = (w = 40, h = 30, { alpha = false, color = { r: 20, g: 120, b: 220 }, noise = false } = {}) => {
  const base = noise
    ? { create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }
    : { create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { ...color, alpha: 0.5 } : color } };
  return sharp(base).png().toBuffer();
};

/** A JPEG that says "rotate me 90°" and carries an owner name and GPS position in its EXIF block. */
export const jpegWithExif = (w = 60, h = 30) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 0, b: 0 } } })
  .jpeg().withMetadata({ orientation: 6 })
  .withExif({ IFD0: { Copyright: SECRET }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '1/1 2/1 3/1' } })
  .toBuffer();

export const jpeg = (w = 40, h = 30) => sharp({ create: { width: w, height: h, channels: 3, background: '#3a3' } }).jpeg().toBuffer();
export const webp = (w = 40, h = 30) => sharp({ create: { width: w, height: h, channels: 3, background: '#a3a' } }).webp().toBuffer();

/** An animated GIF with `n` frames of `w`×`h`. */
export function animatedGif(w = 40, h = 30, n = 5) {
  const raw = Buffer.alloc(w * h * n * 4);
  for (let f = 0; f < n; f++) for (let i = 0; i < w * h; i++) { const o = (f * w * h + i) * 4; raw[o] = (f * 50) % 256; raw[o + 1] = 100; raw[o + 2] = 200; raw[o + 3] = 255; }
  return sharp(raw, { raw: { width: w, height: h * n, channels: 4, pageHeight: h } }).gif({ delay: Array(n).fill(100), loop: 0 }).toBuffer();
}

export const meta = (buf, opts = {}) => sharp(buf, opts).metadata();

// ---- hostile files ----------------------------------------------------------------------------------------------------
export const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"><script>alert(1)</script><rect width="9" height="9"/></svg>');
export const html = () => Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');

/** A real PNG with a script appended after its end. */
export const pngWithScript = async () => Buffer.concat([await png(60, 40, { noise: true }), Buffer.from('<script>alert(1)</script>')]);

/** A PNG that starts like a real image but is cut in half. */
export const truncatedPng = async () => { const b = await png(300, 300, { noise: true }); return b.subarray(0, Math.floor(b.length / 2)); };

/** Just the header of a huge PNG (no pixel data): what a decompression bomb looks like on the wire. */
export function pngBomb(width = 60000, height = 60000) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 1; ihdr[9] = 0; // 1-bit greyscale
  const idat = zlib.deflateSync(Buffer.alloc(64));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
