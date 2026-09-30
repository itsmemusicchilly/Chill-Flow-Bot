// Draft vs. live: what the editor saves is a draft, what visitors see is a snapshot that only Publish changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { defaultBlockData, hasUnpublishedChanges, normalizePage, validatePage } from '../shared/blocks.js';
import { resetLimits } from '../shared/limits.js';
import { canonicalJson } from '../shared/util.js';
import { Database, livePage } from '../server/db.js';
import { A, B, startHarness } from './helpers/harness.js';

const OLD_SCHEMA = `
CREATE TABLE pages (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL, blocks TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT,
  UNIQUE (guild_id, slug)
);`;
const text = (body) => ({ id: 't1', type: 'text', data: { ...defaultBlockData('text'), body } });
const page = (over = {}) => ({ guildId: A, slug: 'p', title: 'Title', theme: { mode: 'dark' }, blocks: [text('Hello')], ...over });

describe('database: migrating an older file', () => {
  let dir; let file;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-migrate-')); file = path.join(dir, 'old.sqlite'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const makeOld = () => {
    const old = new DatabaseSync(file);
    old.exec(OLD_SCHEMA);
    const ins = old.prepare('INSERT INTO pages (id, guild_id, slug, title, published, theme, blocks, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)');
    ins.run('livepage', A, 'live-one', 'Live one', 1, JSON.stringify({ mode: 'light' }), JSON.stringify([text('What visitors see')]), 1000, 2000, JSON.stringify({ id: 'u1', name: 'Mia' }));
    ins.run('draftpage', A, 'draft-one', 'Draft one', 0, JSON.stringify({}), JSON.stringify([text('Not public')]), 1000, 3000, null);
    old.close();
  };

  it('adds the new columns and turns what is public today into the live version', () => {
    makeOld();
    const db = new Database(file);
    const live = db.getPage(A, 'livepage');
    assert.equal(live.published, true);
    assert.deepEqual(live.live, { title: 'Live one', theme: { mode: 'light' }, blocks: [text('What visitors see')], at: 2000, by: { id: 'u1', name: 'Mia' } });
    assert.deepEqual([live.access, live.roleIds], ['public', []], 'existing pages stay open to everyone');
    assert.equal(livePage(live).blocks[0].data.body, 'What visitors see');
    const draft = db.getPage(A, 'draftpage');
    assert.deepEqual([draft.published, draft.live, draft.access], [false, null, 'public']);
    assert.equal(livePage(draft), null);
    db.close();
  });

  it('is safe to run again: nothing is changed a second time', () => {
    makeOld();
    const first = new Database(file);
    const snapshot = JSON.stringify(first.getPage(A, 'livepage'));
    first.updatePage(A, 'livepage', { title: 'Edited draft' }); // the draft moves on…
    first.close();
    const again = new Database(file);
    const page2 = again.getPage(A, 'livepage');
    assert.equal(page2.title, 'Edited draft');
    assert.equal(page2.live.title, 'Live one', '…but the live snapshot is not re-taken from it');
    assert.notEqual(JSON.stringify(page2), snapshot);
    assert.equal(again.getPage(A, 'draftpage').live, null);
    again.close();
  });
});

describe('database: drafts and live versions', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());

  it('a page created as published starts with a live version equal to its content', () => {
    const p = db.createPage(page({ published: true }));
    assert.equal(p.published, true);
    assert.deepEqual([p.live.title, p.live.theme, p.live.blocks], [p.title, p.theme, p.blocks]);
    assert.equal(db.createPage(page({ slug: 'q' })).live, null, 'a new page is a draft');
  });

  it('saving changes the draft only — never publishes, unpublishes or touches the live version', () => {
    const p = db.createPage(page({ published: true }));
    const saved = db.updatePage(A, p.id, { title: 'New title', blocks: [text('Changed')], published: false, live: null });
    assert.equal(saved.title, 'New title');
    assert.equal(saved.published, true);
    assert.equal(saved.live.title, 'Title');
    assert.equal(saved.live.blocks[0].data.body, 'Hello');
    assert.equal(livePage(saved).title, 'Title', 'visitors still get the old version');
    assert.equal(db.updatePage(A, p.id, { access: 'roles', roleIds: ['333333'] }).access, 'roles');
  });

  it('publish copies the draft to live; unpublish drops it; discard goes back to it', () => {
    const p = db.createPage(page());
    db.updatePage(A, p.id, { title: 'Second' });
    const live = db.publishPage(A, p.id, { id: 'u1', name: 'Mia' });
    assert.equal(live.published, true);
    assert.deepEqual([live.live.title, live.live.by], ['Second', { id: 'u1', name: 'Mia' }]);
    db.updatePage(A, p.id, { title: 'Third' });
    assert.equal(db.discardDraft(A, p.id).title, 'Second', 'the draft is a copy of live again');
    const off = db.unpublishPage(A, p.id);
    assert.deepEqual([off.published, off.live, off.title], [false, null, 'Second'], 'the draft survives going offline');
    assert.equal(db.discardDraft(A, p.id), null, 'nothing to go back to');
  });

  it('every operation is scoped to its server', () => {
    const p = db.createPage(page({ published: true }));
    assert.equal(db.publishPage(B, p.id), null);
    assert.equal(db.discardDraft(B, p.id), null);
    db.unpublishPage(B, p.id);
    assert.equal(db.getPage(A, p.id).published, true);
  });
});

describe('shared: what counts as a change', () => {
  it('canonicalJson ignores key order and nothing else', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ y: 1, x: 2 }] }), canonicalJson({ a: [{ x: 2, y: 1 }], b: 1 }));
    assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
    assert.equal(canonicalJson({ a: undefined, b: 1 }), canonicalJson({ b: 1 }));
    assert.equal(canonicalJson(null), 'null');
  });

  it('detects a real change, ignores key order and fields older snapshots do not have', () => {
    const draft = { title: 'T', slug: 's', theme: { mode: 'dark', accent: '#5865f2', width: 'normal', description: '', previewImage: '' }, blocks: [text('Hi')], published: true };
    const same = { ...draft, live: { title: 'T', theme: { width: 'normal', accent: '#5865f2', mode: 'dark' }, blocks: [{ data: { ...defaultBlockData('text'), body: 'Hi' }, type: 'text', id: 't1' }] } };
    assert.equal(hasUnpublishedChanges(same), false, 'reordered keys and a snapshot from before the preview fields existed are not changes');
    assert.equal(hasUnpublishedChanges({ ...same, title: 'T2' }), true);
    assert.equal(hasUnpublishedChanges({ ...same, blocks: [text('Hi!')] }), true);
    assert.equal(hasUnpublishedChanges({ ...same, theme: { ...same.theme, description: 'New' } }), true, 'the link preview is part of what is published');
    assert.equal(hasUnpublishedChanges({ ...same, access: 'members', slug: 'other' }), false, 'access and address apply at once, so they are never "unpublished"');
    assert.equal(hasUnpublishedChanges({ ...draft, published: false, live: null }), false);
  });

  it('normalises the link preview and the access settings', () => {
    const p = normalizePage({ title: 'T', slug: 'a', theme: { description: `  ${'d'.repeat(500)} `, previewImage: ' https://x.example/a.png ' }, access: 'roles', roleIds: ['333333', '333333', 'x', 42, '12'] });
    assert.equal(p.theme.description.length, 200);
    assert.equal(p.theme.previewImage, 'https://x.example/a.png');
    assert.deepEqual([p.access, p.roleIds], ['roles', ['333333']], 'duplicates, junk and short ids are dropped');
    const many = normalizePage({ title: 'T', slug: 'a', access: 'roles', roleIds: Array.from({ length: 5000 }, (_, i) => String(100000 + i)) });
    assert.equal(many.roleIds.length, 250, 'never more roles than a Discord server can have');
  });

  it('checks the preview picture and the role list', () => {
    const base = { title: 'T', slug: 'a', blocks: [] };
    assert.deepEqual(validatePage(normalizePage(base)), []);
    const http = validatePage(normalizePage({ ...base, theme: { previewImage: 'http://x.example/a.png' } }));
    assert.match(http[0].message, /preview picture must be a full https link/);
    const mangled = validatePage(normalizePage({ ...base, theme: { previewImage: 'upload:nope' } }));
    assert.ok(mangled.some((i) => i.kind === 'config' && /not a valid uploaded image/.test(i.message)));
    const noRoles = validatePage(normalizePage({ ...base, access: 'roles' }));
    assert.ok(noRoles.some((i) => i.kind === 'config' && /at least one role/.test(i.message)), 'a roles page with no roles would let nobody in');
    const gone = validatePage(normalizePage({ ...base, access: 'roles', roleIds: ['333333', '999999'] }), { roles: new Set(['333333']) });
    assert.deepEqual(gone.map((i) => [i.kind, i.level]), [['access', 'warning']]);
    const pic = validatePage(normalizePage({ ...base, theme: { previewImage: 'upload:abcdefghij012345' } }), { uploads: new Set() });
    assert.deepEqual(pic.map((i) => [i.kind, i.level]), [['image', 'warning']]);
  });
});

describe('API: saving, publishing, discarding', () => {
  let h;
  before(async () => { h = await startHarness({ config: { publicRate: { ip: 100000, views: 100000, visitor: 100000 } } }); });
  after(() => h.close());
  beforeEach(() => { resetLimits(); h.state.managers = new Set([`${A}:u1`, `${B}:u1`]); });

  const call = (...args) => h.call(...args);
  const base = (gid = A) => `/api/guilds/${gid}/pages`;
  const create = async (title, gid = A) => (await call('POST', base(gid), { body: { templateId: 'blank', title } })).json.page;
  const save = (p, body, gid = A) => call('PUT', `${base(gid)}/${p.id}`, { body });
  const act = (p, verb, opts = {}, gid = A) => call('POST', `${base(gid)}/${p.id}/${verb}`, opts);
  const seen = (p) => call('GET', p.path ?? `/s/${p.guildId}/${p.slug}`, { sid: null }); // the API describes a page with its public `path`
  const blocksWith = (body) => [{ id: 'txt1', type: 'text', data: { ...defaultBlockData('text'), body } }];

  it('what visitors see only changes when you publish', async () => {
    const p = await create('First version');
    assert.equal((await seen({ guildId: A, slug: p.slug })).status, 404, 'a new page is a draft');
    await save(p, { blocks: blocksWith('Version one text') });
    const published = (await act(p, 'publish')).json.page;
    assert.deepEqual([published.published, published.changed], [true, false]);
    assert.ok(published.publishedAt > 0);
    assert.equal(published.publishedBy.name, 'Mia');
    const first = await seen(published);
    assert.equal(first.status, 200);
    assert.match(first.text, /First version/);
    assert.match(first.text, /Version one text/);

    const edited = (await save(p, { title: 'Second version', blocks: blocksWith('Version two text') })).json.page;
    assert.deepEqual([edited.published, edited.changed], [true, true], 'still live, now with changes that are not');
    const still = (await seen(edited)).text;
    assert.match(still, /Version one text/);
    assert.doesNotMatch(still, /Version two text|Second version/, 'the draft never leaks to visitors');

    const republished = (await act(p, 'publish')).json.page;
    assert.equal(republished.changed, false);
    assert.match((await seen(republished)).text, /Version two text/);
  });

  it('discard puts the draft back to what is live', async () => {
    const p = await create('Keep me');
    await save(p, { blocks: blocksWith('Live text') });
    await act(p, 'publish');
    await save(p, { title: 'Oops', blocks: blocksWith('Regrettable text') });
    const back = (await act(p, 'discard')).json.page;
    assert.deepEqual([back.title, back.changed, back.blocks[0].data.body], ['Keep me', false, 'Live text']);
    assert.equal(h.db.getPage(A, p.id).live.title, 'Keep me');
    const never = await create('Never published');
    const refused = await act(never, 'discard');
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /not been published/);
  });

  it('unpublish takes the page offline but keeps the draft, and it can go live again', async () => {
    const p = await create('Comes and goes');
    await save(p, { blocks: blocksWith('Some text') });
    await act(p, 'publish');
    const off = (await act(p, 'unpublish')).json.page;
    assert.deepEqual([off.published, off.changed, off.publishedAt], [false, false, null]);
    assert.equal(h.db.getPage(A, p.id).live, null);
    assert.equal((await seen({ guildId: A, slug: p.slug })).status, 404);
    assert.equal(off.blocks[0].data.body, 'Some text');
    await act(p, 'publish');
    assert.equal((await seen({ guildId: A, slug: p.slug })).status, 200);
  });

  it('refuses to publish a page with real problems and leaves the live version alone', async () => {
    const p = await create('Sturdy');
    await save(p, { blocks: blocksWith('Fine text') });
    await act(p, 'publish');
    const broken = [{ id: 'f1', type: 'form', data: { ...defaultBlockData('form'), fields: [] } }];
    const saved = await save(p, { blocks: broken });
    assert.equal(saved.status, 200, 'the draft can be saved in any state');
    const refused = await act(p, 'publish');
    assert.equal(refused.status, 400);
    assert.match(refused.json.issues[0].message, /at least one question/);
    assert.match((await seen({ guildId: A, slug: p.slug })).text, /Fine text/, 'visitors are unaffected');
    assert.equal((await save(p, { blocks: broken, title: '' })).status, 200);
    assert.equal((await act(p, 'publish')).status, 400, 'a missing title is a problem too');
  });

  it('access settings apply as soon as they are saved (they are not versioned)', async () => {
    const p = await create('Gated');
    await save(p, { blocks: blocksWith('Secret') });
    await act(p, 'publish');
    const saved = (await save(p, { access: 'roles', roleIds: ['333333', 'junk'] })).json.page;
    assert.deepEqual([saved.access, saved.roleIds, saved.changed], ['roles', ['333333'], false]);
    assert.equal(h.db.getPage(A, p.id).access, 'roles');
    assert.equal((await save(p, { access: 'everyone' })).json.page.access, 'public', 'unknown values fall back to public');
    const listed = (await call('GET', base())).json.find((x) => x.id === p.id);
    assert.deepEqual([listed.access, listed.published, listed.changed], ['public', true, false]);
  });

  it('warns about a role that no longer exists, without blocking anything', async () => {
    const p = await create('Roles');
    const saved = (await save(p, { access: 'roles', roleIds: ['333333', '999999'] })).json.page;
    assert.deepEqual(saved.issues.map((i) => [i.kind, i.level]), [['access', 'warning']]);
    assert.equal((await act(p, 'publish')).status, 200);
  });

  it('a page of another server cannot be published, unpublished, discarded or saved through this one', async () => {
    const mine = await create('Mine');
    await save(mine, { blocks: blocksWith('Mine text') });
    await act(mine, 'publish');
    const before = JSON.stringify(h.db.getPage(A, mine.id));
    for (const verb of ['publish', 'unpublish', 'discard']) assert.equal((await act(mine, verb, {}, B)).status, 404, verb);
    assert.equal((await save(mine, { title: 'Hijacked' }, B)).status, 404);
    assert.equal(JSON.stringify(h.db.getPage(A, mine.id)), before);
  });

  it('needs a session, the live admin check and our own origin', async () => {
    const p = await create('Guarded');
    for (const verb of ['publish', 'unpublish', 'discard']) {
      assert.equal((await act(p, verb, { sid: null })).status, 401, `${verb} without a session`);
      assert.equal((await act(p, verb, { origin: 'https://evil.example' })).status, 403, `${verb} from another site`);
    }
    h.state.managers.delete(`${A}:u1`);
    assert.equal((await act(p, 'publish')).status, 403);
    assert.equal(h.db.getPage(A, p.id).published, false);
  });

  it('responses and the CSV use the questions visitors actually answered', async () => {
    const p = await create('Survey');
    const form = { id: 'form1', type: 'form', data: { ...defaultBlockData('form'), title: 'Survey', fields: [{ id: 'q1', label: 'Old question', type: 'short', required: true, placeholder: '', help: '', options: '', min: '', max: '' }] } };
    await save(p, { blocks: [form] });
    await act(p, 'publish');
    h.db.addResponse({ guildId: A, pageId: p.id, blockId: 'form1', userId: 'v1', userName: 'Vee', answers: { q1: 'Yes' } });
    const renamed = structuredClone(form);
    renamed.data.fields[0].label = 'Brand new question';
    await save(p, { blocks: [renamed] });
    const csv = (await call('GET', `${base()}/${p.id}/responses.csv?form=form1`)).text;
    assert.match(csv.split('\n')[0], /Old question/);
    assert.doesNotMatch(csv.split('\n')[0], /Brand new/);
    await act(p, 'publish');
    assert.match((await call('GET', `${base()}/${p.id}/responses.csv?form=form1`)).text.split('\n')[0], /Brand new question/);
  });

  it('a duplicate is an unpublished copy that keeps the draft and the access settings', async () => {
    const p = await create('Original');
    await save(p, { blocks: blocksWith('Body'), access: 'members' });
    await act(p, 'publish');
    await save(p, { title: 'Original, edited' });
    const copy = (await act(p, 'duplicate')).json.page;
    assert.deepEqual([copy.published, copy.title, copy.access], [false, 'Original, edited (copy)', 'members']);
    assert.equal(h.db.getPage(A, copy.id).live, null);
  });
});
