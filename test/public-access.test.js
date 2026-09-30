// Who may open a public page: anyone, members of the server, or members with one of some roles — and that it always fails closed.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { defaultBlockData } from '../shared/blocks.js';
import { resetLimits } from '../shared/limits.js';
import { A, B, MEMBERS, startHarness, STAFF } from './helpers/harness.js';
import { assertInert } from './helpers/inert.js';

let h;
let n = 0;
before(async () => { h = await startHarness({ config: { publicRate: { ip: 100000, views: 100000, visitor: 100000 } } }); });
after(() => h.close());
beforeEach(() => { resetLimits(); h.state.members.clear(); });

const SECRET = 'The vault code is 1234';
const TITLE = 'Staff handbook';
const text = { id: 't1', type: 'text', data: { ...defaultBlockData('text'), body: SECRET } };
const form = () => ({ id: 'form1', type: 'form', data: { ...defaultBlockData('form'), title: 'Apply', successMessage: 'All done!', requireMember: false, fields: [{ id: 'name', label: 'Name', type: 'short', required: true, placeholder: '', help: '', options: '', min: '', max: '' }] } });
const gated = ({ access = 'members', roleIds = [], blocks = [text], guildId = A } = {}) => {
  n += 1;
  return h.db.createPage({ guildId, slug: `g${n}`, title: TITLE, theme: { description: 'Secret description', accent: '#ff8800' }, blocks, published: true, access, roleIds });
};
const visitor = (name = 'Vee') => { n += 1; const id = `v${n}`; return { id, name, sid: h.visitorSession({ id, name, avatar: null }) }; };
const path = (p) => `/s/${p.guildId}/${p.slug}`;
const open = (p, v, opts = {}) => h.call('GET', path(p), { sid: null, visitor: v?.sid, ...opts });
const csrf = (html) => html.match(/name="_csrf" value="([0-9a-f]{64})"/)?.[1];
const seenNothing = (r) => {
  assert.doesNotMatch(r.text, new RegExp(`${SECRET}|${TITLE}|Secret description`), 'no title, content or description of the page');
  assert.equal(/<meta (name|property)="(og:|description|theme-color)/.test(r.text), false, 'no link-preview tags');
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.match(r.text, /name="robots" content="noindex"/);
  assertInert(r.text);
};

describe('a page for anyone', () => {
  it('is unchanged: no login, no lookup', async () => {
    const p = gated({ access: 'public' });
    let asked = 0;
    const real = h.bot.getMember;
    h.bot.getMember = async (...args) => { asked += 1; return real(...args); };
    try {
      const r = await open(p);
      assert.equal(r.status, 200);
      assert.match(r.text, new RegExp(SECRET));
      assert.equal(asked, 0);
    } finally { h.bot.getMember = real; }
  });
});

describe('a page for members of the server', () => {
  it('asks a stranger to log in — and shows nothing of the page', async () => {
    const p = gated();
    const r = await open(p);
    assert.equal(r.status, 401);
    seenNothing(r);
    assert.match(r.text, /Log in with Discord/);
    assert.ok(r.text.includes(`/auth/visitor/login?next=${encodeURIComponent(path(p))}`), 'and comes back to the page afterwards');
    assert.match(r.text, /Pixel Café/, 'it does say which server');
  });

  it('turns a logged-in non-member away, and lets a member in', async () => {
    const p = gated();
    const v = visitor();
    const refused = await open(p, v);
    assert.equal(refused.status, 403);
    seenNothing(refused);
    assert.match(refused.text, /Only members of Pixel Café/);
    assert.match(refused.text, /Signed in as <b>Vee<\/b>/, 'they can switch account');
    h.setRoles(A, v.id, []);
    const ok = await open(p, v);
    assert.equal(ok.status, 200);
    assert.match(ok.text, new RegExp(SECRET));
    assert.equal(ok.res.headers.get('cache-control'), 'no-store');
    assert.match(ok.text, /Signed in as <b>Vee<\/b>/, 'a page without a form still has a way to log out');
    assert.ok(ok.text.includes(`name="next" value="${path(p)}"`));
    assertInert(ok.text);
  });

  it('a page with a form shows the signed-in line once, not twice', async () => {
    const p = gated({ blocks: [text, form()] });
    const v = visitor();
    h.setRoles(A, v.id, []);
    assert.equal(((await open(p, v)).text.match(/Signed in as/g) ?? []).length, 1);
  });

  it('membership is about the page\'s own server', async () => {
    const p = gated();
    const v = visitor();
    h.setRoles(B, v.id, [STAFF]); // a member of the OTHER server, with a role
    assert.equal((await open(p, v)).status, 403);
  });
});

describe('a page for members with certain roles', () => {
  it('needs any one of the chosen roles', async () => {
    const p = gated({ access: 'roles', roleIds: [STAFF, MEMBERS] });
    const none = visitor('None'); h.setRoles(A, none.id, []);
    const other = visitor('Other'); h.setRoles(A, other.id, ['555555']);
    const staff = visitor('Staff'); h.setRoles(A, staff.id, [STAFF]);
    const members = visitor('Members'); h.setRoles(A, members.id, [MEMBERS]);
    const refused = await open(p, none);
    assert.equal(refused.status, 403);
    seenNothing(refused);
    assert.match(refused.text, /does not have access/);
    assert.doesNotMatch(refused.text, /Staff|Members\b.*role/, 'role names are not revealed');
    assert.equal((await open(p, other)).status, 403, 'a different role is not enough');
    assert.equal((await open(p, staff)).status, 200);
    assert.equal((await open(p, members)).status, 200);
    assert.equal((await open(p)).status, 401);
  });

  it('a role change is picked up on the next visit', async () => {
    const p = gated({ access: 'roles', roleIds: [STAFF] });
    const v = visitor();
    h.setRoles(A, v.id, [STAFF]);
    assert.equal((await open(p, v)).status, 200);
    h.setRoles(A, v.id, []);
    assert.equal((await open(p, v)).status, 403);
  });

  it('the roles of another server do not count', async () => {
    const p = gated({ access: 'roles', roleIds: ['777777'] }); // a role id that does not exist in this server
    const v = visitor();
    h.setRoles(A, v.id, [STAFF, MEMBERS]);
    assert.equal((await open(p, v)).status, 403);
  });
});

describe('it fails closed', () => {
  it('a roles page with no roles lets nobody in (not even someone with every role)', async () => {
    const p = gated({ access: 'roles', roleIds: [] });
    const v = visitor();
    h.setRoles(A, v.id, [STAFF, MEMBERS]);
    assert.equal((await open(p, v)).status, 403);
  });

  it('an unknown access value is a refusal, never an open door', async () => {
    const p = gated();
    h.db.db.prepare("UPDATE pages SET access = 'weird' WHERE id = ?").run(p.id);
    const v = visitor();
    h.setRoles(A, v.id, [STAFF]);
    assert.equal((await open(p, v)).status, 403);
    assert.equal((await open(p)).status, 401);
  });

  it('a failing member lookup is a refusal, not an error page and not access', async () => {
    const p = gated();
    const v = visitor();
    h.setRoles(A, v.id, [STAFF]);
    const real = h.bot.getMember;
    h.bot.getMember = async () => { throw new Error('Discord is down'); };
    try {
      const r = await open(p, v);
      assert.equal(r.status, 403);
      seenNothing(r);
    } finally { h.bot.getMember = real; }
  });

  it('the dashboard login is not a visitor login', async () => {
    const p = gated();
    const r = await h.call('GET', path(p), { sid: h.session() }); // a signed-in admin, but no visitor session
    assert.equal(r.status, 401);
  });

  it('access applies to what is live at once, even though the page has newer unpublished edits', async () => {
    const p = gated({ access: 'public' });
    h.db.updatePage(A, p.id, { title: 'Draft only', access: 'members' }); // tightened while editing: no Publish needed
    const r = await open(p);
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.text, /Draft only/);
  });
});

describe('a link crawler', () => {
  it('learns nothing from a gated link, but gets the card of a public one', async () => {
    const ua = { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' };
    const secret = await open(gated(), null, { headers: ua });
    assert.equal(secret.status, 401);
    seenNothing(secret);
    const roles = await open(gated({ access: 'roles', roleIds: [STAFF] }), null, { headers: ua });
    seenNothing(roles);
    const pub = await open(gated({ access: 'public' }), null, { headers: ua });
    assert.match(pub.text, /property="og:title" content="Staff handbook"/);
  });
});

describe('forms on a gated page', () => {
  it('cannot be sent around the gate, even with a valid token', async () => {
    const p = gated({ access: 'public', blocks: [text, form()] });
    const v = visitor();
    h.setRoles(A, v.id, []);
    const token = csrf((await open(p, v)).text); // minted while the page was open to everyone
    assert.ok(token);
    h.db.updatePage(A, p.id, { access: 'roles', roleIds: [STAFF] }); // …then the admins lock it down
    const post = (opts = {}) => h.call('POST', `${path(p)}/f/form1`, { sid: null, visitor: v.sid, form: { _csrf: token, f_name: 'Vee' }, ...opts });
    const refused = await post();
    assert.equal(refused.status, 403);
    seenNothing(refused);
    assert.equal(h.db.countResponses(A, p.id, 'form1'), 0, 'nothing was stored');
    const anon = await post({ visitor: undefined });
    assert.equal(anon.status, 401);
    h.setRoles(A, v.id, [STAFF]);
    const ok = await post();
    assert.equal(ok.status, 303);
    assert.equal(h.db.countResponses(A, p.id, 'form1'), 1);
  });

  it('the thank-you page is gated too', async () => {
    const p = gated({ access: 'roles', roleIds: [STAFF], blocks: [text, form()] });
    const url = `${path(p)}/thanks?f=form1`;
    const v = visitor();
    h.setRoles(A, v.id, []);
    assert.equal((await h.call('GET', url, { sid: null })).status, 401);
    const refused = await h.call('GET', url, { sid: null, visitor: v.sid });
    assert.equal(refused.status, 403);
    assert.doesNotMatch(refused.text, /All done!/);
    h.setRoles(A, v.id, [STAFF]);
    const ok = await h.call('GET', url, { sid: null, visitor: v.sid });
    assert.equal(ok.status, 200);
    assert.match(ok.text, /All done!/);
  });

  it('a page that does not exist or is unpublished still looks like any other 404', async () => {
    const p = gated();
    h.db.unpublishPage(A, p.id);
    const r = await open(p);
    assert.equal(r.status, 404);
    assert.match(r.text, /Page not found/);
  });
});
