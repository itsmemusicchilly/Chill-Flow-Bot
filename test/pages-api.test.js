import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { newBlock } from '../shared/blocks.js';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { toCsv } from '../server/csv.js';
import { A, B, startHarness } from './helpers/harness.js';

let h;
before(async () => { h = await startHarness(); });
after(() => h.close());
beforeEach(() => { resetLimits(); h.state.managers = new Set([`${A}:u1`, `${B}:u1`]); });
afterEach(resetLimits);

const call = (...args) => h.call(...args);
const create = async (body = { templateId: 'application' }, gid = A) => (await call('POST', `/api/guilds/${gid}/pages`, { body })).json.page;

describe('pages API', () => {
  it('creates from a template (never published), with a free web address', async () => {
    const first = await create();
    assert.equal(first.published, false);
    assert.equal(first.slug, 'apply');
    assert.equal(first.forms, 1);
    const second = await create();
    assert.equal(second.slug, 'apply-2', 'a taken address is never an error on create');
    assert.equal(first.url, `http://localhost:3999/s/${A}/apply`);
    assert.equal(first.blocks.length, 2);
    assert.deepEqual(first.issues, []);
  });

  it('requires a session, the live admin check, and a known server', async () => {
    assert.equal((await call('GET', `/api/guilds/${A}/pages`, { sid: null })).status, 401);
    h.state.managers.delete(`${A}:u1`);
    assert.equal((await call('GET', `/api/guilds/${A}/pages`)).status, 403);
    h.state.managers.add(`${A}:u1`);
    assert.equal((await call('GET', `/api/guilds/${A}/pages`, { origin: 'https://evil.example' })).status, 200, 'reads are fine');
    assert.equal((await call('POST', `/api/guilds/${A}/pages`, { body: { templateId: 'blank' }, origin: 'https://evil.example' })).status, 403, 'writes need our own origin');
  });

  it('a page id from one server cannot be read, changed, copied, deleted or its responses touched through another', async () => {
    const page = await create({ templateId: 'application' }, A);
    const formId = page.blocks.find((b) => b.type === 'form').id;
    const rid = h.db.addResponse({ guildId: A, pageId: page.id, blockId: formId, userId: '9', userName: 'x', answers: { a: 'secret' } });
    for (const [m, p, body] of [['GET', ''], ['PUT', '', { title: 'pwned' }], ['DELETE', ''], ['POST', '/duplicate'], ['GET', `/responses?form=${formId}`], ['GET', `/responses.csv?form=${formId}`], ['DELETE', `/responses/${rid}`]]) {
      assert.equal((await call(m, `/api/guilds/${B}/pages/${page.id}${p}`, { body })).status, 404, `${m} ${p}`);
    }
    assert.equal(h.db.getPage(A, page.id).title, page.title);
    assert.equal(h.db.countResponses(A, page.id, formId), 1);
    assert.deepEqual((await call('GET', `/api/guilds/${B}/pages`)).json, []);
    assert.deepEqual((await call('GET', `/api/guilds/${B}/forms`)).json, []);
  });

  it('saves edits, and slug conflicts are a clear 409', async () => {
    const one = await create({ templateId: 'contact' });
    const two = await create({ templateId: 'rules' });
    const saved = await call('PUT', `/api/guilds/${A}/pages/${one.id}`, { body: { title: 'Talk to us', theme: { mode: 'light', accent: '#ff8800' } } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.page.title, 'Talk to us');
    assert.equal(saved.json.page.theme.mode, 'light');
    assert.equal(saved.json.page.updatedBy.name, 'Mia');
    const clash = await call('PUT', `/api/guilds/${A}/pages/${two.id}`, { body: { slug: saved.json.page.slug } });
    assert.equal(clash.status, 409);
    assert.match(clash.json.error, /already used/);
  });

  it('rejects structurally broken pages without saving them', async () => {
    const page = await create();
    const before = JSON.stringify(h.db.getPage(A, page.id));
    for (const patch of [{ slug: 'Bad Slug!' }, { blocks: [{ id: 'x', type: 'script', data: {} }] }, { blocks: [{ id: 'dup', type: 'divider', data: {} }, { id: 'dup', type: 'divider', data: {} }] }]) {
      const r = await call('PUT', `/api/guilds/${A}/pages/${page.id}`, { body: patch });
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.ok(r.json.issues.length);
    }
    assert.equal(JSON.stringify(h.db.getPage(A, page.id)), before);
    assert.equal((await call('POST', `/api/guilds/${A}/pages`, { body: { templateId: 'nope' } })).status, 400);
  });

  it('publishes a healthy page, and refuses to publish one with a broken form (saving the draft is always allowed)', async () => {
    const page = await create({ templateId: 'contact' });
    const live = await call('POST', `/api/guilds/${A}/pages/${page.id}/publish`);
    assert.equal(live.status, 200);
    assert.equal(live.json.page.published, true);
    assert.equal(live.json.page.changed, false);
    const blocks = structuredClone(live.json.page.blocks);
    blocks.find((b) => b.type === 'form').data.fields = [];
    const saved = await call('PUT', `/api/guilds/${A}/pages/${page.id}`, { body: { blocks } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.page.published, true, 'saving a draft never switches a live page off');
    assert.equal(saved.json.page.changed, true);
    assert.match(saved.json.page.issues.map((i) => i.message).join(), /at least one question/);
    const refused = await call('POST', `/api/guilds/${A}/pages/${page.id}/publish`);
    assert.equal(refused.status, 400);
    assert.match(refused.json.issues.map((i) => i.message).join(), /at least one question/);
  });

  it('duplicates as an unpublished copy with its own address', async () => {
    const page = await create({ templateId: 'rules' });
    await call('POST', `/api/guilds/${A}/pages/${page.id}/publish`);
    const copy = (await call('POST', `/api/guilds/${A}/pages/${page.id}/duplicate`)).json.page;
    assert.equal(copy.published, false);
    assert.equal(copy.slug, `${page.slug}-copy`);
    assert.match(copy.title, /\(copy\)$/);
    assert.notEqual(copy.id, page.id);
  });

  it('deleting a page erases its responses', async () => {
    const page = await create();
    const formId = page.blocks.find((b) => b.type === 'form').id;
    h.db.addResponse({ guildId: A, pageId: page.id, blockId: formId, userId: '9', userName: 'x', answers: {} });
    assert.equal((await call('DELETE', `/api/guilds/${A}/pages/${page.id}`)).status, 200);
    assert.equal(h.db.countResponses(A, page.id, formId), 0);
    assert.equal((await call('GET', `/api/guilds/${A}/pages/${page.id}`)).status, 404);
  });

  it('lists every form with a stable key for the flow trigger', async () => {
    const page = await create({ templateId: 'contact' });
    const forms = (await call('GET', `/api/guilds/${A}/forms`)).json;
    const mine = forms.find((f) => f.pageId === page.id);
    assert.equal(mine.key, `${page.id}:${mine.blockId}`);
    assert.match(mine.label, /Contact the admins › Send us a message/);
    assert.deepEqual(mine.fields.map((f) => f.id), ['topic', 'message', 'reply']);
  });

  it('has no policy limits by default; caps apply once set', async () => {
    for (let i = 0; i < 30; i += 1) assert.equal((await call('POST', `/api/guilds/${B}/pages`, { body: { title: `p${i}`, blocks: [] } })).status, 201);
    const many = { blocks: Array.from({ length: 200 }, (_, i) => newBlock('divider', `d${i}`)) };
    const p = (await call('POST', `/api/guilds/${B}/pages`, { body: { title: 'long', ...many } }));
    assert.equal(p.status, 201);
    applyLimits({ pagesPerGuild: 3, blocksPerPage: 5 });
    assert.equal((await call('POST', `/api/guilds/${B}/pages`, { body: { title: 'over' } })).status, 409);
    assert.equal((await call('PUT', `/api/guilds/${B}/pages/${p.json.page.id}`, { body: { title: 'x' } })).status, 400, 'now over the block cap');
  });
});

describe('responses', () => {
  let page; let formId;
  before(async () => {
    page = await create({ templateId: 'application' });
    formId = page.blocks.find((b) => b.type === 'form').id;
    for (let i = 0; i < 7; i += 1) {
      const id = h.db.addResponse({ guildId: A, pageId: page.id, blockId: formId, userId: `u${i}`, userName: `User ${i}`, answers: { name: `N${i}`, why: i === 0 ? '=HYPERLINK("http://evil","x")' : i === 1 ? 'has, comma\nand "quotes"' : 'ok', age: i === 2 ? -5 : 20, role: 'Helper', rules: 'Yes' } });
      // distinct timestamps: rows created in the same millisecond would otherwise be ordered by their random ids
      h.db.db.prepare('UPDATE form_responses SET created_at = ? WHERE id = ?').run(Date.now() - (10 - i) * 1000, id);
    }
  });

  it('pages through responses, newest first', async () => {
    const r = await call('GET', `/api/guilds/${A}/pages/${page.id}/responses?form=${formId}&limit=3&offset=0`);
    assert.equal(r.json.total, 7);
    assert.equal(r.json.rows.length, 3);
    const next = await call('GET', `/api/guilds/${A}/pages/${page.id}/responses?form=${formId}&limit=3&offset=6`);
    assert.equal(next.json.rows.length, 1);
    assert.equal((await call('GET', `/api/guilds/${A}/pages/${page.id}/responses?form=bad!id`)).status, 400);
  });

  it('deletes one response', async () => {
    const before = (await call('GET', `/api/guilds/${A}/pages/${page.id}/responses?form=${formId}`)).json;
    const victim = before.rows[0].id;
    assert.equal((await call('DELETE', `/api/guilds/${A}/pages/${page.id}/responses/${victim}`)).status, 200);
    assert.equal((await call('DELETE', `/api/guilds/${A}/pages/${page.id}/responses/${victim}`)).status, 404);
    assert.equal(h.db.countResponses(A, page.id, formId), 6);
  });

  it('exports CSV with a header, proper quoting and a spreadsheet-formula guard', async () => {
    const r = await call('GET', `/api/guilds/${A}/pages/${page.id}/responses.csv?form=${formId}`);
    assert.equal(r.status, 200);
    assert.match(r.res.headers.get('content-type'), /text\/csv/);
    assert.equal(r.res.headers.get('content-disposition'), `attachment; filename="responses-${page.slug}.csv"`);
    assert.ok(r.text.startsWith('Submitted at,Discord user ID,Discord username,What should we call you?,'));
    assert.ok(r.text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`) || r.text.includes(`'=HYPERLINK(""http://evil"",""x"")`), 'formula cells are defused');
    assert.ok(!/,=HYPERLINK/.test(r.text) && !/(^|\n)=HYPERLINK/.test(r.text));
    assert.ok(r.text.includes('"has, comma\nand ""quotes"""'), 'commas, newlines and quotes are escaped');
    assert.ok(r.text.includes(',-5,'), 'real numbers are left alone');
  });

  it('csv helper unit cases', () => {
    assert.equal(toCsv(['a', 'b'], [['x,y', 'z']]), '﻿a,b\r\n"x,y",z\r\n');
    assert.equal(toCsv(['a'], [['+1'], ['-x'], ['@s'], ['\tt'], [5], [['A', 'B']]]), "﻿a\r\n'+1\r\n'-x\r\n'@s\r\n'\tt\r\n5\r\n\"A, B\"\r\n");
  });
});
