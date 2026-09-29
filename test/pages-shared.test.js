import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BLOCK_LIST, defaultBlockData, formsOf, hasPageStructureErrors, newBlock, normalizePage, validatePage } from '../shared/blocks.js';
import { ANSWER_MAX, parseOptions, summarize, validateSubmission } from '../shared/forms.js';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { PAGE_TEMPLATES } from '../shared/page-templates.js';
import { esc, renderInline, renderMarkdown, renderNotFound, renderNotice, renderPage } from '../shared/render-page.js';
import { safeUrl } from '../shared/urls.js';
import { assertInert } from './helpers/inert.js';

afterEach(resetLimits);

const guild = { id: '123456789012345678', name: 'Pixel Café', icon: null };

const PAYLOADS = ['"><img src=x onerror=alert(1)>', '<script>alert(1)</script>', "'</style><script>alert(1)</script>", 'javascript:alert(1)', 'https://user:pw@evil.example/', '{{constructor}}', '\u0001x\u0001'];
const mapStrings = (v, payload) => {
  if (typeof v === 'string') return payload;
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, payload));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, payload)]));
  return v;
};

describe('safeUrl', () => {
  it('accepts only clean http(s) URLs without credentials', () => {
    assert.equal(safeUrl('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&c=2');
    assert.equal(safeUrl('http://example.com'), 'http://example.com/');
    assert.equal(safeUrl('http://example.com', { httpsOnly: true }), null);
    assert.equal(safeUrl('  https://x.example/\n'), 'https://x.example/', 'surrounding whitespace is trimmed; inner whitespace is rejected');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example', '/relative', 'ftp://x.example', 'https://a.example/ b', 'https://user:pw@x.example', 'https://x.example/a\nb', '', null, undefined, 'https://' + 'a'.repeat(3000) + '.com']) {
      assert.equal(safeUrl(bad), null, String(bad).slice(0, 40));
    }
  });
});

describe('form submissions', () => {
  const form = {
    fields: [
      { id: 'name', label: 'Name', type: 'short', required: true, max: 10, min: 2 },
      { id: 'why', label: 'Why', type: 'long', required: false },
      { id: 'age', label: 'Age', type: 'number', required: true, min: 13, max: 120 },
      { id: 'role', label: 'Role', type: 'select', required: true, options: 'Mod\nHelper' },
      { id: 'pick', label: 'Pick', type: 'radio', required: false, options: 'A\nB' },
      { id: 'likes', label: 'Likes', type: 'checkboxes', required: true, options: 'A\nB\nC' },
      { id: 'ok', label: 'Rules', type: 'agree', required: true },
      { id: 'when', label: 'When', type: 'date', required: false },
    ],
  };
  const good = { f_name: 'Mia', f_age: '20', f_role: 'Mod', f_likes: ['A', 'C'], f_ok: 'on' };

  it('accepts a good submission and types the answers', () => {
    const r = validateSubmission(form, good);
    assert.equal(r.ok, true);
    assert.deepEqual(r.answers, { name: 'Mia', why: '', age: 20, role: 'Mod', pick: '', likes: ['A', 'C'], ok: 'Yes', when: '' });
  });

  it('a lone checkbox value is treated as a list of one', () => {
    assert.deepEqual(validateSubmission(form, { ...good, f_likes: 'B' }).answers.likes, ['B']);
  });

  it('rejects missing, out-of-range, unknown-option and malformed answers', () => {
    const r = validateSubmission(form, { f_name: 'x', f_age: '5', f_role: 'Admin', f_likes: ['Z'], f_when: '2026-02-30', f_pick: 'C' });
    assert.deepEqual(Object.keys(r.errors).sort(), ['age', 'likes', 'name', 'ok', 'pick', 'role', 'when']);
    assert.equal(r.ok, false);
    assert.equal(validateSubmission(form, { ...good, f_name: 'x'.repeat(11) }).errors.name, 'Write at most 10 characters.');
    assert.equal(validateSubmission(form, { ...good, f_age: 'abc' }).errors.age, 'Enter a number.');
    assert.equal(validateSubmission(form, { ...good, f_ok: undefined }).errors.ok, 'You need to tick this to continue.');
  });

  it('keeps what was typed so the form can be shown again', () => {
    const r = validateSubmission(form, { ...good, f_age: 'abc' });
    assert.equal(r.values.name, 'Mia');
    assert.deepEqual(r.values.likes, ['A', 'C']);
  });

  it('ignores unknown fields, strips control characters and enforces the physical ceiling', () => {
    const r = validateSubmission(form, { ...good, f_evil: 'x', f_name: 'M\u0000i\u0007a', f_why: 'y'.repeat(ANSWER_MAX + 1) });
    assert.equal(r.answers.name, 'Mia');
    assert.equal('evil' in r.answers, false);
    assert.match(r.errors.why, /Too long/);
  });

  it('short answers cannot contain line breaks; long answers keep them', () => {
    assert.equal(validateSubmission(form, { ...good, f_name: 'Mi\r\na' }).answers.name, 'Mi a');
    assert.equal(validateSubmission(form, { ...good, f_why: 'a\r\nb' }).answers.why, 'a\nb');
  });

  it('parses options and summarises answers', () => {
    assert.deepEqual(parseOptions(' A \n\nB\r\nA\n'), ['A', 'B']);
    assert.equal(summarize(form, { name: 'Mia', likes: ['A', 'C'] }).split('\n').slice(0, 2).join('|'), 'Name: Mia|Why: —');
  });
});

describe('block catalog and page validation', () => {
  it('every block is well formed and renders with its defaults', () => {
    for (const d of BLOCK_LIST) {
      assert.ok(d.label && d.icon && d.description && Array.isArray(d.fields) && typeof d.summary === 'function', d.type);
      const keys = d.fields.map((f) => f.key);
      assert.equal(new Set(keys).size, keys.length, `${d.type} duplicate keys`);
    }
    const page = { title: 'x', slug: 'x', theme: {}, blocks: BLOCK_LIST.map((d) => newBlock(d.type)) };
    assertInert(renderPage({ page, guild }));
  });

  const good = () => normalizePage({ title: 'T', slug: 'my-page', blocks: [newBlock('heading', 'h1'), { id: 'f1', type: 'form', data: { ...defaultBlockData('form'), fields: [{ id: 'a', label: 'A', type: 'short', required: true, options: '', min: '', max: '' }] } }] });

  it('accepts a good page', () => assert.deepEqual(validatePage(good()), []));

  it('rejects structural problems', () => {
    const bad = (mutate) => { const p = good(); mutate(p); return hasPageStructureErrors(validatePage(p)); };
    assert.ok(bad((p) => { p.slug = 'Bad Slug!'; }));
    assert.ok(bad((p) => { p.slug = '-x'; }));
    assert.ok(bad((p) => { p.slug = 'a'.repeat(41); }));
    assert.ok(bad((p) => { p.blocks[1].id = 'h1'; }));
    assert.ok(bad((p) => { p.blocks[0].type = 'script'; }));
    assert.ok(bad((p) => { p.blocks[0].id = 'has space'; }));
    assert.ok(bad((p) => { p.blocks[0].data = { text: 'x'.repeat(200 * 1024) }; }));
    applyLimits({ blocksPerPage: 1 });
    assert.ok(bad(() => {}));
  });

  it('reports form and URL mistakes as to-dos', () => {
    const p = good();
    Object.assign(p.blocks[1].data, { fields: [{ id: 'a', label: 'A', type: 'select', options: '' }, { id: 'a', label: 'B', type: 'short' }, { id: 'title', label: 'C', type: 'short' }, { id: '1bad', label: 'D', type: 'short' }], onSuccess: 'redirect', redirectUrl: 'javascript:alert(1)' });
    const msgs = validatePage(p).map((i) => i.message).join(' | ');
    for (const re of [/needs at least one option/, /Duplicate question ID/, /reserved/, /must be letters/, /redirect address must be a full/]) assert.match(msgs, re);
    assert.ok(!hasPageStructureErrors(validatePage(p)), 'these are to-dos, not unsavable');
    const hero = normalizePage({ title: 'T', slug: 'a', blocks: [{ id: 'h', type: 'hero', data: { ...defaultBlockData('hero'), imageUrl: 'http://insecure.example/x.png', buttonUrl: 'javascript:1' } }] });
    assert.match(validatePage(hero).map((i) => i.message).join(), /background image must be a full https link/);
  });

  it('normalises input, keeping only known theme values', () => {
    const p = normalizePage({ title: `  ${'t'.repeat(200)} `, slug: ' MY-Page ', theme: { mode: 'weird', accent: 'red', width: 'huge', extra: 1 }, blocks: 'nope', published: 1, access: 'everyone', roleIds: 'nope' });
    assert.equal(p.title.length, 80);
    assert.equal(p.slug, 'my-page');
    assert.deepEqual(p.theme, { mode: 'dark', accent: '#5865f2', width: 'normal', description: '', previewImage: '' });
    assert.deepEqual(p.blocks, []);
    assert.equal('published' in p, false, 'publishing is not part of a page\'s content');
    assert.deepEqual([p.access, p.roleIds], ['public', []], 'unknown access values fall back to public');
  });

  it('lists forms for the flow trigger', () => {
    assert.deepEqual(formsOf(good()), [{ blockId: 'f1', title: 'Apply', fields: [{ id: 'a', label: 'A', type: 'short' }] }]);
  });

  it('every starter template is valid and renders', () => {
    for (const t of PAGE_TEMPLATES) {
      const page = normalizePage({ ...t.build(), theme: {} });
      assert.ok(!hasPageStructureErrors(validatePage(page)), t.id);
      assert.deepEqual(validatePage(page).map((i) => i.message), [], t.id);
      assertInert(renderPage({ page, guild }));
    }
  });
});

describe('rendering is inert', () => {
  it('escapes and neutralises hostile content in EVERY field of EVERY block', () => {
    for (const payload of PAYLOADS) {
      const blocks = BLOCK_LIST.map((d) => {
        let data = mapStrings(defaultBlockData(d.type), payload);
        if (d.type === 'form') {
          data = { ...data, fields: ['short', 'long', 'number', 'select', 'radio', 'checkboxes', 'agree', 'date'].map((type, i) => ({ id: `q${i}`, label: payload, type, required: true, placeholder: payload, help: payload, options: `${payload}\n${payload}2`, min: payload, max: payload })) };
        }
        return { id: `b${d.type}`, type: d.type, data };
      });
      const page = { title: payload, slug: 'x', theme: { mode: 'dark', accent: payload, width: payload }, blocks };
      const formState = Object.fromEntries(blocks.filter((b) => b.type === 'form').map((b) => [b.id, { errors: { q0: payload }, values: { q0: payload, q5: [payload] }, formError: payload }]));
      for (const visitor of [null, { name: payload }]) {
        assertInert(renderPage({ page, guild: { id: '1', name: payload, icon: payload }, visitor, csrf: () => payload, formState }));
      }
      assertInert(renderPage({ page, guild, mode: 'preview' }));
    }
  });

  it('markdown: formatting works, HTML and dangerous links stay text', () => {
    assert.equal(renderInline('**b** *i*'), '<strong>b</strong> <em>i</em>');
    assert.equal(renderInline('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
    assert.match(renderInline('[ok](https://a.example/?x=1&y=2)'), /<a href="https:\/\/a\.example\/\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer nofollow ugc">ok<\/a>/);
    for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](https://u:p@evil.example)', '[x](//evil.example)']) assert.ok(!renderInline(bad).includes('<a'), bad);
    assert.ok(!renderInline('[x](https://a.example/*not-bold*)').includes('<em>'), 'formatting characters inside a URL are left alone');
    assert.equal(renderMarkdown('one\n\ntwo\nline'), '<p>one</p><p>two<br>line</p>');
  });

  it('esc handles all five characters and non-strings', () => {
    assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
    assert.equal(esc(null), '');
    assert.equal(esc(42), '42');
  });

  it('shows a login button to visitors who are not signed in, and a real form (with token) once they are', () => {
    const page = normalizePage({ title: 'T', slug: 'apply', blocks: [{ id: 'f1', type: 'form', data: { ...defaultBlockData('form'), fields: [{ id: 'a', label: 'A', type: 'short', required: true }] } }] });
    const anon = renderPage({ page, guild });
    assert.match(anon, /href="\/auth\/visitor\/login\?next=%2Fs%2F123456789012345678%2Fapply"/);
    assert.ok(!anon.includes('<form method="post" action="/s/'));
    const signed = renderPage({ page, guild, visitor: { name: 'Mia' }, csrf: (id) => `tok-${id}` });
    assert.match(signed, /<form method="post" action="\/s\/123456789012345678\/apply\/f\/f1"/);
    assert.match(signed, /name="_csrf" value="tok-f1"/);
    assert.match(signed, /name="f_a"/);
    assert.match(signed, /Signed in as <b>Mia<\/b>/);
    const blocked = renderPage({ page, guild, visitor: { name: 'Mia' }, formState: { f1: { blocked: 'member' } } });
    assert.match(blocked, /only for members/);
    assert.ok(!blocked.includes('name="f_a"'));
  });

  it('preview mode switches the form off and never links to login', () => {
    const page = normalizePage({ title: 'T', slug: 'apply', blocks: [newBlock('form', 'f1')] });
    const html = renderPage({ page, guild, mode: 'preview' });
    assert.match(html, /<fieldset disabled>/);
    assert.match(html, /name="robots" content="noindex"/);
    assert.ok(!html.includes('/auth/visitor/login'));
  });

  it('every page carries the anti-phishing footer and the data notice', () => {
    const page = normalizePage({ title: 'T', slug: 'x', blocks: [newBlock('form', 'f1')] });
    for (const html of [renderPage({ page, guild }), renderPage({ page, guild, mode: 'preview' }), renderNotice({ page, guild, title: 'Thanks', message: 'ok' })]) {
      assert.match(html, /not made or endorsed by Discord/);
      assert.match(html, /Never type your password, token or login codes/);
    }
    assert.match(renderPage({ page, guild }), /receive your answers together with your Discord username and ID/);
  });

  it('the not-found page reveals nothing', () => {
    const html = renderNotFound();
    assertInert(html);
    assert.ok(!html.includes('class="brand"'));
  });

  it('image hosts never see the page URL (no referrer) and external links are marked ugc', () => {
    const page = normalizePage({ title: 'T', slug: 'x', blocks: [{ id: 'i1', type: 'image', data: { ...defaultBlockData('image'), url: 'https://img.example/a.png' } }, { id: 'b1', type: 'button', data: { ...defaultBlockData('button'), url: 'https://example.com' } }] });
    const html = renderPage({ page, guild });
    assert.match(html, /<img src="https:\/\/img\.example\/a\.png"[^>]*referrerpolicy="no-referrer"/);
    assert.match(html, /rel="noopener noreferrer nofollow ugc"/);
  });
});

