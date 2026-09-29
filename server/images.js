// Uploaded images are never stored or served as they were sent. Every file is decoded here, stripped of all metadata
// (EXIF/GPS, comments, colour profiles), turned upright, shrunk and re-encoded as WebP, so the only bytes that ever reach a
// visitor are ones we encoded ourselves. That removes whole classes of trouble at once: SVG/HTML/script polyglots, trailing
// data, hidden metadata and surprise formats.
//
// These are physical ceilings that protect the process (memory, CPU), not policy limits: the operator's own caps
// (LIMIT_UPLOAD_BYTES, …) are enforced by the upload API on top of them.

export const IMAGE_LIMITS = Object.freeze({
  maxInputBytes: 32 * 1024 * 1024, // what one request may carry
  maxOutputBytes: 16 * 1024 * 1024, // what one stored image may take
  maxPixels: 64_000_000, // decoded pixels of a still image (8000 × 8000)
  maxAnimatedPixels: 30_000_000, // all frames together: they are held in memory at once
  maxFrames: 200,
  maxEdge: 2400, // longest side after resizing (never enlarged)
  quality: 85,
  concurrency: 2, // images decoded at the same time
});

export class ImageError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const UNSUPPORTED = 'Only PNG, JPEG, WebP and GIF pictures can be uploaded.';
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

/** The format a file *claims* by its first bytes. libvips only ever gets files that start like one of the four we accept. */
export function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// ---- sharp is a native library: load it lazily so a platform without a prebuilt binary only loses uploads ----------------
let state = 'pending'; // pending | ready | failed
let loading = null;
let loadError = null;

function loadSharp() {
  loading ??= import('sharp').then((mod) => {
    const sharp = mod.default;
    sharp.cache(false); // no shared pixel cache: memory stays predictable
    sharp.concurrency(IMAGE_LIMITS.concurrency);
    state = 'ready';
    return sharp;
  }).catch((err) => {
    state = 'failed';
    loadError = err;
    throw new ImageError(501, 'Image uploads are not available on this server (the image library could not be loaded).');
  });
  return loading;
}

/** Start loading in the background; `available()` tells the editor whether to offer uploads. */
export function warmUp() { loadSharp().catch(() => {}); }
export const available = () => state !== 'failed';
export const unavailableReason = () => (loadError ? String(loadError.message ?? loadError).split('\n')[0] : null);

// ---- a tiny gate so a burst of uploads cannot decode many big images at once ---------------------------------------------
let active = 0;
const waiting = [];
async function gate(fn, max) {
  if (active >= max) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try { return await fn(); } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/**
 * Decode, clean and re-encode one uploaded image.
 * @param {Buffer} input the bytes as uploaded
 * @param {Partial<typeof IMAGE_LIMITS>} [override] (tests lower the ceilings)
 * @returns {Promise<{ data: Buffer, width: number, height: number, animated: boolean, frames: number }>}
 */
export async function processImage(input, override = {}) {
  const lim = { ...IMAGE_LIMITS, ...override };
  if (!Buffer.isBuffer(input) || input.length === 0) throw new ImageError(400, 'That file is empty.');
  if (input.length > lim.maxInputBytes) throw new ImageError(413, `That file is too large (the most this server takes is ${Math.floor(lim.maxInputBytes / 1048576)} MB).`);
  if (!sniff(input)) throw new ImageError(415, UNSUPPORTED);
  const sharp = await loadSharp();

  return gate(async () => {
    try {
      // 1. Header only: real format, size and frame count. `limitInputPixels` also makes this refuse a "pixel bomb" outright.
      const meta = await sharp(input, { limitInputPixels: lim.maxPixels, failOn: 'error' }).metadata();
      if (!FORMATS.has(meta.format)) throw new ImageError(415, UNSUPPORTED);
      const frames = meta.pages ?? 1;
      const animated = frames > 1;
      if (animated && frames > lim.maxFrames) throw new ImageError(413, `That animation has too many frames (at most ${lim.maxFrames}).`);

      // 2. Decode → upright → shrink → WebP. Nothing is copied over except pixels; metadata is dropped by default.
      const { data, info } = await sharp(input, { animated, limitInputPixels: animated ? lim.maxAnimatedPixels : lim.maxPixels, failOn: 'error' })
        .rotate()
        .resize({ width: lim.maxEdge, height: lim.maxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: lim.quality })
        .toBuffer({ resolveWithObject: true });
      if (data.length > lim.maxOutputBytes) throw new ImageError(413, 'That picture is still too large after shrinking it. Try a smaller image.');
      return { data, width: info.width, height: info.pageHeight ?? info.height, animated, frames };
    } catch (err) {
      if (err instanceof ImageError) throw err;
      const msg = String(err?.message ?? err);
      if (/pixel limit/i.test(msg)) throw new ImageError(413, 'That picture has too many pixels. Shrink it (for example to 4000 pixels wide) and try again.');
      if (/unsupported image format/i.test(msg)) throw new ImageError(415, UNSUPPORTED);
      throw new ImageError(422, 'That picture could not be read. It may be damaged or cut off.');
    }
  }, lim.concurrency);
}
