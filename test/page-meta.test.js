// Link previews: what a pasted page link shows in Discord, and that nothing else ever gets those tags.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { defaultBlockData } from '../shared/blocks.js';
import { pageMeta } from '../shared/page-meta.js';
import { renderNotFound, renderNotice, renderPage } from '../shared/render-page.js';
import { A, startHarness } from './helpers/harness.js';
import { assertInert } from './helpers/inert.js';
import { png } from './helpers/images.js';

const BASE = 'https://bot.example.com';
const GID = '123456789012345678';
const ID = 'abcdefghij012345';
const icon = 'https://cdn.discordapp.com/icons/123456789012345678/abc.png?size=64';
const guild = { id: GID, name: 'Pixel Café', icon };
const hero = (data) => ({ id: 'h1', type: 'hero', data: { ...defaultBlockData('hero'), ...data } });
const text = (body) => ({ id: 't1', type: 'text', data: { ...defaultBlockData('text'), body } });
const page = (over = {}) => ({ title: 'Rules', slug: 'rules', published: true, theme: {}, blocks: [], ...over });
const meta = (p, g = guild) => pageMeta(p, { guild: g, baseUrl: BASE });
const tags = (html) => [...html.matchAll(/<meta (name|property)="([^"]+)" content="([^"]*)">/g)].map((m) => [m[2], m[3]]);
const tag = (html, key) => tags(html).find(([k]) => k === key)?.[1];

describe('what a pasted link shows', () => {
  it('has the page title, the server name, the address and the accent colour', () => {
    const m = meta(page({ title: 'Server rules', slug: 'rules', theme: { accent: '#ff8800' } }));
    assert.deepEqual([m.title, m.siteName, m.url, m.color], ['Server rules', 'Pixel Café', `${BASE}/s/${GID}/rules`, '#ff8800']);
    assert.equal(meta(page({ title: '', theme: { accent: 'nope' } })).title, 'Untitled page');
    assert.equal(meta(page({ theme: { accent: 'nope' } })).color, '#5865f2');
  });

  it('describes the page with what the admin wrote, else its own text — with no setup', () => {
    const blocks = [hero({ subtitle: 'Be **kind** to each other' }), text('First *paragraph* with a [link](https://x.example).\n\nSecond paragraph.')];
    assert.equal(meta(page({ theme: { description: 'Written by hand' }, blocks })).description, 'Written by hand');
    assert.equal(meta(page({ blocks })).description, 'Be kind to each other', 'the hero subtitle comes first');
    assert.equal(meta(page({ blocks: [text('First *paragraph* with a [link](https://x.example).\n\nSecond paragraph.')] })).description, 'First paragraph with a link.', 'markdown marks and later paragraphs are left out');
    assert.equal(meta(page({ blocks: [text('x'.repeat(400))] })).description.length, 160);
    assert.equal(meta(page({ blocks: [text('a\n b\t\tc')] })).description, 'a b c', 'one line');
    assert.equal(meta(page()).description, '', 'no text at all: no description');
  });

  it('picks the picture: the one chosen for the page, else the hero, else the server icon', () => {
    assert.equal(meta(page({ theme: { previewImage: `upload:${ID}` }, blocks: [hero({ imageUrl: 'https://x.example/hero.png' })] })).image, `${BASE}/i/${GID}/${ID}.webp`, 'an upload becomes an absolute address on this site');
    assert.equal(meta(page({ theme: { previewImage: 'https://x.example/pick.png' } })).image, 'https://x.example/pick.png');
    const fromHero = meta(page({ blocks: [hero({ imageUrl: 'https://x.example/hero.png' })] }));
    assert.deepEqual([fromHero.image, fromHero.card], ['https://x.example/hero.png', 'summary_large_image']);
    const fromIcon = meta(page());
    assert.deepEqual([fromIcon.image, fromIcon.card], ['https://cdn.discordapp.com/icons/123456789012345678/abc.png?size=256', 'summary'], 'a square icon is a thumbnail, at a size that looks fine');
    assert.equal(meta(page(), { ...guild, icon: null }).image, null);
    assert.equal(meta(page(), { ...guild, icon: 'https://evil.example/x.png' }).image, null, 'only Discord\'s own icon address is trusted');
  });

  it('ignores a picture that cannot be used and falls through to the next one', () => {
    for (const bad of ['http://x.example/a.png', 'javascript:alert(1)', 'upload:nope', `upload:${ID}x`, 'data:image/png;base64,AAAA', '/i/1/2.webp']) {
      const m = meta(page({ theme: { previewImage: bad }, blocks: [hero({ imageUrl: 'https://x.example/hero.png' })] }));
      assert.equal(m.image, 'https://x.example/hero.png', bad);
    }
    assert.equal(pageMeta(page({ theme: { previewImage: `upload:${ID}` } }), { guild: { ...guild, icon: null }, baseUrl: '' }).image, null, 'without a public address an upload cannot be made absolute');
  });
});

describe('the tags on the page', () => {
  const render = (p, opts = {}) => renderPage({ page: p, guild, baseUrl: BASE, ...opts });
  const good = page({ title: 'Server rules', theme: { description: 'Read these first', accent: '#ff8800', previewImage: `upload:${ID}` }, blocks: [text('Hi')] });

  it('a public page carries Open Graph tags, a description and the accent colour', () => {
    const html = render(good);
    assert.equal(tag(html, 'og:title'), 'Server rules');
    assert.equal(tag(html, 'og:description'), 'Read these first');
    assert.equal(tag(html, 'description'), 'Read these first');
    assert.equal(tag(html, 'og:site_name'), 'Pixel Café');
    assert.equal(tag(html, 'og:type'), 'website');
    assert.equal(tag(html, 'og:url'), `${BASE}/s/${GID}/rules`);
    assert.equal(tag(html, 'og:image'), `${BASE}/i/${GID}/${ID}.webp`);
    assert.equal(tag(html, 'twitter:card'), 'summary_large_image');
    assert.equal(tag(html, 'theme-color'), '#ff8800');
    assertInert(html);
  });

  it('leaves out what it does not have instead of printing empty tags', () => {
    const html = render(page({ title: 'Bare' }), { guild: { ...guild, icon: null } });
    assert.equal(tag(html, 'og:description'), undefined);
    assert.equal(tag(html, 'description'), undefined);
    assert.equal(tag(html, 'og:image'), undefined);
    assert.ok(tag(html, 'og:title'));
  });

  it('only real public pages have them: not previews, not without an address, not notices or the 404', () => {
    assert.equal(tag(render(good, { mode: 'preview' }), 'og:title'), undefined, 'editor preview');
    assert.equal(tag(renderPage({ page: good, guild }), 'og:title'), undefined, 'no public address known');
    assert.equal(tags(renderNotFound()).some(([k]) => k.startsWith('og:')), false);
    assert.equal(tags(renderNotice({ page: good, guild, title: 'Members only', message: 'Log in', href: '/x', hrefLabel: 'Go' })).some(([k]) => k.startsWith('og:') || k === 'description'), false);
  });

  it('hostile text stays text: escaped in the tags, nothing new is created', () => {
    const evil = '"><script>alert(1)</script><meta property="og:image" content="https://evil.example/x.png';
    for (const field of ['description', 'previewImage']) {
      const html = render(page({ title: evil, theme: { [field]: evil, description: field === 'description' ? evil : '' }, blocks: [text(evil)] }));
      assert.equal(/<script/i.test(html), false, field);
      assertInert(html);
      assert.equal(tags(html).filter(([k]) => k === 'og:image').every(([, v]) => !v.includes('evil.example')), true, `${field}: no injected image tag`);
    }
    const quoted = render(page({ title: 'He said "hi" & <b>left</b>' }));
    assert.equal(tag(quoted, 'og:title'), 'He said &quot;hi&quot; &amp; &lt;b&gt;left&lt;/b&gt;');
  });
});

describe('on the real public site', () => {
  let h;
  before(async () => { h = await startHarness({ config: { baseUrl: 'https://bot.example.com', uploadRate: { perUser: 1000 } } }); });
  after(() => h.close());

  it('shows the LIVE page\'s preview (with its uploaded picture), not the draft\'s', async () => {
    const up = await h.call('POST', `/api/guilds/${A}/uploads`, { raw: await png(80, 40, { noise: true }), type: 'image/png', origin: 'https://bot.example.com' });
    assert.equal(up.status, 201);
    const ref = up.json.upload.ref;
    const p = h.db.createPage({ guildId: A, slug: 'preview', title: 'Live title', theme: { description: 'Live description', previewImage: ref }, blocks: [text('Body')], published: true });
    h.db.updatePage(A, p.id, { title: 'Draft title', theme: { description: 'Draft description', previewImage: '' } });

    const crawler = await h.call('GET', `/s/${A}/preview`, { sid: null, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } });
    assert.equal(crawler.status, 200);
    assert.equal(tag(crawler.text, 'og:title'), 'Live title');
    assert.equal(tag(crawler.text, 'og:description'), 'Live description');
    assert.equal(tag(crawler.text, 'og:image'), `https://bot.example.com/i/${A}/${up.json.upload.id}.webp`);
    assert.doesNotMatch(crawler.text, /Draft title|Draft description/);
    const img = await h.call('GET', `/i/${A}/${up.json.upload.id}.webp`, { sid: null });
    assert.equal(img.status, 200, 'and the picture the card points at is really there');
  });
});
