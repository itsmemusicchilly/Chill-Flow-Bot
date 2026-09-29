import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { available, IMAGE_LIMITS, ImageError, processImage, sniff } from '../server/images.js';
import { animatedGif, html, jpeg, jpegWithExif, meta, png, pngBomb, pngWithScript, SECRET, svg, truncatedPng, webp } from './helpers/images.js';

const rejects = (input, status, message, opts) => assert.rejects(() => processImage(input, opts), (err) => {
  assert.ok(err instanceof ImageError, `expected an ImageError, got ${err}`);
  assert.equal(err.status, status, err.message);
  if (message) assert.match(err.message, message);
  return true;
});

describe('image pipeline: what comes out', () => {
  it('re-encodes every accepted format as WebP', async () => {
    for (const [name, make] of [['png', () => png()], ['jpeg', () => jpeg()], ['webp', () => webp()], ['gif', () => animatedGif(20, 20, 1)]]) {
      const out = await processImage(await make());
      const m = await meta(out.data);
      assert.equal(m.format, 'webp', name);
      assert.equal(out.width, m.width, name);
    }
  });

  it('strips EXIF (owner name, GPS) and applies the rotation', async () => {
    const input = await jpegWithExif(60, 30);
    assert.ok(input.includes(Buffer.from(SECRET)), 'the fixture really contains the secret');
    assert.equal((await meta(input)).orientation, 6);
    const out = await processImage(input);
    assert.equal(out.data.includes(Buffer.from(SECRET)), false);
    const m = await meta(out.data);
    assert.equal(Boolean(m.exif), false);
    assert.equal(Boolean(m.icc), false);
    assert.deepEqual([out.width, out.height], [30, 60], 'orientation 6 turns a 60×30 picture upright');
  });

  it('shrinks big pictures to the longest-side ceiling but never enlarges small ones', async () => {
    const big = await processImage(await png(3000, 1500), {});
    assert.deepEqual([big.width, big.height], [IMAGE_LIMITS.maxEdge, IMAGE_LIMITS.maxEdge / 2]);
    const small = await processImage(await png(50, 20));
    assert.deepEqual([small.width, small.height], [50, 20]);
  });

  it('keeps transparency', async () => {
    const out = await processImage(await png(30, 30, { alpha: true }));
    assert.equal((await meta(out.data)).hasAlpha, true);
  });

  it('keeps animations animated (and shrinks each frame)', async () => {
    const out = await processImage(await animatedGif(40, 30, 5));
    assert.equal(out.animated, true);
    assert.equal(out.frames, 5);
    const m = await meta(out.data, { animated: true });
    assert.equal(m.pages, 5);
    assert.deepEqual([out.width, out.height], [40, 30]);
    const shrunk = await processImage(await animatedGif(40, 30, 3), { maxEdge: 20 });
    assert.deepEqual([shrunk.width, shrunk.height], [20, 15]);
  });

  it('drops anything appended after the picture (nothing but our own pixels survives)', async () => {
    const out = await processImage(await pngWithScript());
    assert.equal(out.data.includes(Buffer.from('<script')), false);
    assert.equal((await meta(out.data)).format, 'webp');
  });

  it('sniffs only the four accepted formats', async () => {
    assert.equal(sniff(await png()), 'png');
    assert.equal(sniff(await jpeg()), 'jpeg');
    assert.equal(sniff(await webp()), 'webp');
    assert.equal(sniff(await animatedGif()), 'gif');
    assert.equal(sniff(svg()), null);
    assert.equal(sniff(html()), null);
    assert.equal(sniff(Buffer.from('RIFF....WAVEfmt ')), null);
  });
});

describe('image pipeline: what is refused', () => {
  it('reports that the image library is available in this environment', () => {
    assert.equal(available(), true);
  });

  it('empty, SVG, HTML and plain junk', async () => {
    await rejects(Buffer.alloc(0), 400, /empty/);
    await rejects(svg(), 415, /PNG, JPEG, WebP and GIF/);
    await rejects(html(), 415);
    await rejects(Buffer.from('just some text pretending to be a picture, long enough to pass the length check'), 415);
    await rejects(Buffer.from('GIF89a but nothing else that makes any sense at all here'), 422);
  });

  it('a truncated or damaged picture', async () => {
    await rejects(await truncatedPng(), 422, /could not be read/);
    const good = await jpeg(200, 200);
    const broken = Buffer.concat([good.subarray(0, 40), Buffer.alloc(200, 0x55)]);
    await rejects(broken, 422);
  });

  it('a pixel bomb is refused from its header, quickly, without being decoded', async () => {
    const started = Date.now();
    await rejects(pngBomb(60000, 60000), 413, /too many pixels/);
    assert.ok(Date.now() - started < 2000, 'refused fast');
  });

  it('too many pixels overall, too many animation frames, too many bytes', async () => {
    await rejects(await png(300, 300), 413, /too many pixels/, { maxPixels: 50_000 });
    await rejects(await animatedGif(40, 30, 10), 413, /too many frames/, { maxFrames: 5 });
    await rejects(await animatedGif(40, 30, 10), 413, /too many pixels/, { maxAnimatedPixels: 40 * 30 * 3 });
    await rejects(await png(), 413, /too large/, { maxInputBytes: 20 });
    await rejects(await png(200, 200, { noise: true }), 413, /still too large/, { maxOutputBytes: 100 });
  });

  it('a burst of uploads queues up and every one still finishes', async () => {
    const input = await png(400, 400, { noise: true });
    const results = await Promise.all(Array.from({ length: 8 }, () => processImage(input)));
    assert.equal(results.length, 8);
    assert.ok(results.every((r) => r.data.length > 0));
  });
});
