import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultBlockData, validatePage } from '../shared/blocks.js';
import { NODE_TYPES } from '../shared/catalog.js';
import { checkFields, image } from '../shared/fields.js';
import { renderPage } from '../shared/render-page.js';
import { assetSrc, looksLikeUpload, uploadIdOf, uploadPath, uploadRef } from '../shared/urls.js';
import { assertInert } from './helpers/inert.js';

const GID = '123456789012345678';
const ID = 'abcdefghij012345';
const guild = { id: GID, name: 'Pixel Café', icon: null };
const page = (blocks) => ({ title: 'T', slug: 'my-page', published: true, theme: {}, blocks });
const hero = (imageUrl) => ({ id: 'h1', type: 'hero', data: { ...defaultBlockData('hero'), imageUrl } });
const img = (url) => ({ id: 'i1', type: 'image', data: { ...defaultBlockData('image'), url, alt: 'alt' } });
const problems = (fields, data) => { const out = []; checkFields(fields, data, '', (m) => out.push(m)); return out; };

describe('upload references', () => {
  it('recognise exactly `upload:` + 16 lowercase letters/digits', () => {
    assert.equal(uploadIdOf(uploadRef(ID)), ID);
    assert.equal(uploadIdOf(` upload:${ID} `), ID, 'surrounding whitespace is tolerated');
    for (const bad of ['', 'upload:', `upload:${ID}x`, `upload:${ID.slice(1)}`, `upload:${ID.toUpperCase()}`, `Upload:${ID}`, `upload:../${ID.slice(3)}`, `upload:${ID}/..`, `xupload:${ID}`, `https://x.example/upload:${ID}`, `upload:${ID}\nx`, null, undefined, 42, {}]) {
      assert.equal(uploadIdOf(bad), null, String(bad));
    }
    assert.equal(looksLikeUpload('upload:nonsense'), true);
    assert.equal(looksLikeUpload('UPLOAD:x'), true);
    assert.equal(looksLikeUpload('https://x.example/'), false);
    assert.equal(uploadPath(GID, ID), `/i/${GID}/${ID}.webp`);
  });

  it('assetSrc gives a same-origin path for uploads (with an optional base) and https links otherwise', () => {
    assert.equal(assetSrc(uploadRef(ID), { guildId: GID }), `/i/${GID}/${ID}.webp`);
    assert.equal(assetSrc(uploadRef(ID), { guildId: GID, base: 'http://localhost:5173' }), `http://localhost:5173/i/${GID}/${ID}.webp`);
    assert.equal(assetSrc('https://cdn.example/a.png', { guildId: GID }), 'https://cdn.example/a.png');
    assert.equal(assetSrc(uploadRef(ID), {}), null, 'no server → no address');
    assert.equal(assetSrc(uploadRef(ID), { guildId: '../..' }), null);
    for (const bad of ['http://insecure.example/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', `upload:${ID}x`, 'upload:', 'upload:../../x', '/i/1/2.webp', '//evil.example/a.png', '']) {
      assert.equal(assetSrc(bad, { guildId: GID }), null, bad);
    }
  });
});

describe('the image field type', () => {
  const field = image('pic', 'Picture');
  it('is a plain string field with an empty default', () => {
    assert.deepEqual([field.type, field.default], ['image', '']);
  });

  it('accepts links, uploads and templates; rejects mangled upload references', () => {
    for (const ok of ['', 'https://x.example/a.png', uploadRef(ID), '{{user.avatar}}', 'upload:{{var.pic}}']) assert.deepEqual(problems([field], { pic: ok }), [], ok);
    for (const bad of ['upload:', 'upload:short', `upload:${ID}x`, 'upload:../x', 'UPLOAD:x']) {
      const found = problems([field], { pic: bad });
      assert.equal(found.length, 1, bad);
      assert.match(found[0], /not a valid uploaded image/);
    }
  });

  it('is what hero, image blocks and message embeds use', () => {
    assert.equal(defaultBlockData('hero').imageUrl, '');
    for (const type of ['action.message.send', 'action.message.edit']) {
      const embeds = NODE_TYPES[type].fields.find((f) => f.key === 'embeds');
      const types = Object.fromEntries(embeds.item.fields.map((f) => [f.key, f.type]));
      for (const part of ['image', 'thumbnail', 'authorIcon', 'footerIcon']) assert.equal(types[part], 'image', `${type}: ${part}`);
    }
    const patch = NODE_TYPES['action.message.edit'].fields.find((f) => f.key === 'patchSet');
    assert.equal(patch.item.fields.find((f) => f.key === 'image').type, 'image', 'a picture set on an existing embed can be uploaded too');
  });
});

describe('page validation of uploaded images', () => {
  it('accepts an uploaded picture or an https link; http and junk are still refused', () => {
    assert.deepEqual(validatePage(page([hero(uploadRef(ID)), img(uploadRef(ID))])), []);
    assert.deepEqual(validatePage(page([hero('https://x.example/a.png'), img('https://x.example/a.png')])), []);
    const bad = validatePage(page([hero('http://x.example/a.png'), img('not a link')]));
    assert.equal(bad.length, 2);
    assert.ok(bad.every((i) => i.kind === 'config'));
  });

  it('reports a mangled reference once, as a config problem (which keeps a page from going live)', () => {
    const found = validatePage(page([img('upload:oops')]));
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'config');
    assert.match(found[0].message, /not a valid uploaded image/);
  });

  it('warns (only) about a picture that no longer exists, when the server\'s pictures are known', () => {
    const p = page([hero(uploadRef(ID)), img(uploadRef('zzzzzzzzzz999999'))]);
    assert.deepEqual(validatePage(p), [], 'without the list nothing can be said');
    assert.deepEqual(validatePage(p, { uploads: new Set([ID, 'zzzzzzzzzz999999']) }), []);
    const found = validatePage(p, { uploads: new Set([ID]) });
    assert.equal(found.length, 1);
    assert.deepEqual([found[0].blockId, found[0].level, found[0].kind], ['i1', 'warning', 'image']);
    assert.match(found[0].message, /no longer exists/);
  });
});

describe('rendering uploaded pictures', () => {
  const render = (blocks, extra = {}) => renderPage({ page: page(blocks), guild, ...extra });

  it('hero and image blocks point at the same-origin file', () => {
    const html = render([hero(uploadRef(ID)), img(uploadRef('zzzzzzzzzz999999'))]);
    assert.match(html, new RegExp(`<img class="hero-bg" src="/i/${GID}/${ID}\\.webp"`));
    assert.match(html, new RegExp(`<img src="/i/${GID}/zzzzzzzzzz999999\\.webp" alt="alt"`));
    assertInert(html);
  });

  it('the editor preview prefixes the dashboard origin', () => {
    const html = render([img(uploadRef(ID))], { mode: 'preview', assetBase: 'http://localhost:5173' });
    assert.ok(html.includes(`src="http://localhost:5173/i/${GID}/${ID}.webp"`));
    assertInert(html);
  });

  it('never leaks a picture of another server through the page\'s own address', () => {
    const other = renderPage({ page: page([img(uploadRef(ID))]), guild: { ...guild, id: '999999999999999999' } });
    assert.ok(other.includes(`src="/i/999999999999999999/${ID}.webp"`), 'the server id in the address is always the page\'s own');
    assert.equal(other.includes(`/i/${GID}/`), false);
  });

  it('a malformed reference or a bad link renders no picture at all', () => {
    for (const bad of ['upload:', 'upload:short', `upload:${ID}x`, 'upload:../x', 'http://x.example/a.png', 'javascript:alert(1)', '"><img src=x onerror=alert(1)>']) {
      const html = render([hero(bad), img(bad)]);
      assert.equal(html.includes('<img class="hero-bg"'), false, bad);
      assert.equal(/<figure/.test(html), false, bad);
      assertInert(html);
    }
  });

  it('a hostile server id in the page context cannot break out either', () => {
    const html = renderPage({ page: page([img(uploadRef(ID))]), guild: { ...guild, id: '1"><script>alert(1)</script>' } });
    assert.equal(/<script/.test(html), false);
    assert.equal(html.includes(`/i/1"`), false);
  });
});
