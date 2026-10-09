import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { defaultBlockData } from '../shared/blocks.js';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { edge, node } from './helpers/fakes.js';
import { A, B, startHarness } from './helpers/harness.js';
import { assertInert } from './helpers/inert.js';

let h;
let n = 0;
before(async () => { h = await startHarness({ config: { publicRate: { ip: 100000, views: 100000, visitor: 100000 } } }); });
after(() => h.close());
beforeEach(() => { resetLimits(); h.state.members.clear(); });

const question = (over) => ({ required: true, placeholder: '', help: '', options: '', min: '', max: '', ...over });
const formBlock = (over = {}) => ({
  id: 'form1', type: 'form',
  data: {
    ...defaultBlockData('form'), title: 'Apply', successMessage: 'All done!',
    fields: [question({ id: 'name', label: 'Name', type: 'short', max: 30 }), question({ id: 'likes', label: 'Likes', type: 'checkboxes', options: 'Tea\nCoffee', required: false })],
    ...over,
  },
});
/** A published page in server A with one form; returns the page (fresh slug every time). */
function makePage({ form = {}, blocks, guildId = A, published = true, title = 'Apply' } = {}) {
  n += 1;
  return h.db.createPage({ guildId, slug: `p${n}`, title, theme: {}, blocks: blocks ?? [formBlock(form)], published });
}
const path = (p) => `/s/${p.guildId}/${p.slug}`;
const visitor = (id = `v${(n += 1)}`, name = 'Vee') => ({ id, name, sid: h.visitorSession({ id, name, avatar: null }) });
const view = (p, v, opts = {}) => h.call('GET', path(p), { sid: null, visitor: v?.sid, ...opts });
const csrf = (html, blockId = 'form1') => html.match(new RegExp(`action="[^"]*/f/${blockId}"[^>]*><input type="hidden" name="_csrf" value="([0-9a-f]{64})"`))?.[1];
/** A form token as the page would issue it (the visitor must be allowed to see the form at that moment). */
async function tokenFor(p, v, { member = true, blockId = 'form1' } = {}) {
  if (member) h.state.members.add(`${p.guildId}:${v.id}`);
  return csrf((await view(p, v)).text, blockId);
}
async function submit(p, v, fields, { token, blockId = 'form1', origin, member = true, revokeMember = false } = {}) {
  const t = token ?? await tokenFor(p, v, { member, blockId });
  if (revokeMember) h.state.members.delete(`${p.guildId}:${v.id}`); // they were a member when the form was shown, and are not any more
  return h.call('POST', `${path(p)}/f/${blockId}`, { sid: null, visitor: v.sid, form: { _csrf: t ?? 'none', ...fields }, ...(origin !== undefined ? { origin } : {}) });
}
const responses = (p, blockId = 'form1') => h.db.allResponses(p.guildId, p.id, blockId);
const logs = () => h.logger.recent(A).map((l) => l.message);
const flowFor = (p, message, { blockId = 'form1', guildId = A } = {}) => {
  h.db.createFlow({ guildId, name: 'On form', graph: { nodes: [node('t', 'trigger.form.submitted', { form: `${p.id}:${blockId}` }), node('l', 'logic.log', { message })], edges: [edge('t', 'l')] } });
  h.runtime.loadGuild(guildId);
};
const settle = () => new Promise((r) => setTimeout(r, 40));

describe('visitor login', () => {
  const cbCookies = { cookie: 'fc_state=v.abc123; fc_next=%2Fs%2F111111%2Fapply' };

  it('sends visitors to Discord asking for identity only, remembering where to come back to', async () => {
    const r = await h.call('GET', '/auth/visitor/login?next=/s/111111/apply', { sid: null });
    assert.equal(r.status, 302);
    const loc = new URL(r.res.headers.get('location'));
    assert.equal(loc.searchParams.get('scope'), 'identify', 'no server list for visitors');
    assert.ok(loc.searchParams.get('state').startsWith('v.'));
    const cookies = r.res.headers.getSetCookie();
    assert.ok(cookies.some((c) => c.startsWith(`fc_state=${loc.searchParams.get('state')}`) && /HttpOnly/.test(c)));
    assert.ok(cookies.some((c) => c.startsWith('fc_next=%2Fs%2F111111%2Fapply')));
  });

  it('the callback creates a visitor session (and only that), revokes the token, and returns to the page', async () => {
    h.state.discordCalls.length = 0;
    const r = await h.call('GET', '/auth/callback?code=c&state=v.abc123', { sid: null, headers: cbCookies });
    assert.equal(r.status, 302);
    assert.equal(r.res.headers.get('location'), '/s/111111/apply');
    const set = r.res.headers.getSetCookie().find((c) => c.startsWith('fc_visitor='));
    assert.match(set, /HttpOnly; SameSite=Lax/);
    assert.ok(!r.res.headers.getSetCookie().some((c) => c.startsWith('fc_session=') && !c.includes('Max-Age=0')), 'no dashboard session');
    const sid = set.split(';')[0].split('=')[1];
    assert.equal(h.db.getSession(sid).data.visitor, true);
    assert.ok(!h.state.discordCalls.some(([, p]) => p.includes('/guilds')), 'the server list is never requested');
    assert.ok(h.state.discordCalls.some(([m, p]) => m === 'POST' && p.endsWith('/revoke')));
    assert.ok(!JSON.stringify(h.db.db.prepare('SELECT * FROM sessions').all()).includes('access_token'));
  });

  it('never redirects anywhere but a public page of this site', async () => {
    for (const next of ['https://evil.example', '//evil.example', '/api/me', '/s/111111/../x', '/s/abc/apply', '/s/111111/Apply', 'javascript:alert(1)']) {
      const login = await h.call('GET', `/auth/visitor/login?next=${encodeURIComponent(next)}`, { sid: null });
      assert.ok(login.res.headers.getSetCookie().some((c) => c.startsWith('fc_next=%2F;')), `login ignores ${next}`);
      const cb = await h.call('GET', '/auth/callback?code=c&state=v.abc123', { sid: null, headers: { cookie: `fc_state=v.abc123; fc_next=${encodeURIComponent(next)}` } });
      assert.equal(cb.res.headers.get('location'), '/', `callback ignores ${next}`);
    }
  });

  it('rejects a wrong or missing state', async () => {
    for (const cookie of [undefined, 'fc_state=v.other']) {
      const r = await h.call('GET', '/auth/callback?code=c&state=v.abc123', { sid: null, headers: cookie ? { cookie } : {} });
      assert.equal(r.res.headers.get('location'), '/?login=failed');
    }
  });

  it('logout clears the visitor session and only returns to a public page', async () => {
    const v = visitor();
    const r = await h.call('POST', '/auth/visitor/logout', { sid: null, visitor: v.sid, form: { next: '/s/111111/apply' } });
    assert.equal(r.status, 303);
    assert.equal(r.res.headers.get('location'), '/s/111111/apply');
    assert.equal(h.db.getSession(v.sid), null);
    const evil = await h.call('POST', '/auth/visitor/logout', { sid: null, visitor: visitor().sid, form: { next: 'https://evil.example' } });
    assert.equal(evil.res.headers.get('location'), '/');
    assert.equal((await h.call('POST', '/auth/visitor/logout', { sid: null, form: { next: '/' }, origin: 'https://evil.example' })).status, 403);
  });
});

describe('visitor and dashboard sessions never mix', () => {
  it('a visitor cannot use the dashboard API, and a dashboard login is not a visitor login', async () => {
    const v = visitor();
    assert.equal((await h.call('GET', '/api/me', { sid: null, visitor: v.sid })).status, 401);
    assert.equal((await h.call('GET', '/api/me', { sid: v.sid })).status, 401, 'visitor cookie value placed in the dashboard cookie');
    assert.equal((await h.call('GET', `/api/guilds/${A}/pages`, { sid: v.sid })).status, 401);
    const p = makePage();
    const admin = h.session();
    const asAdmin = await h.call('GET', path(p), { sid: null, headers: { cookie: `fc_visitor=${admin}` } });
    assert.match(asAdmin.text, /Log in with Discord/, 'a dashboard session id in the visitor cookie is just "not signed in"');
  });
});

describe('public pages', () => {
  it('unknown, unpublished, wrong-server and malformed addresses all look identical', async () => {
    const live = makePage();
    const draft = makePage({ published: false });
    const other = makePage({ guildId: B });
    const bodies = [];
    for (const url of [`/s/${A}/nope`, path(draft), `/s/${A}/${other.slug}`, `/s/999999/${live.slug}`, `/s/abc/${live.slug}`, `/s/${A}/Bad_Slug`, `/s/${A}/${live.slug}/f/form1/x`]) {
      const r = await h.call('GET', url, { sid: null });
      assert.equal(r.status, 404, url);
      bodies.push(r.text);
    }
    assert.equal(new Set(bodies.slice(0, 6)).size, 1, 'no page or server name leaks');
    assert.ok(!bodies[0].includes('Apply') && !bodies[0].includes('Pixel'));
    assert.equal((await view(live)).status, 200);
  });

  it('is served with a no-script CSP and clickjacking / sniffing protection', async () => {
    const r = await view(makePage());
    const csp = r.res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/script-src/.test(csp) && !csp.includes("'unsafe-eval'"));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.equal(r.res.headers.get('x-frame-options'), 'DENY');
    // "no-referrer" would make browsers send `Origin: null` on same-origin form POSTs and break every submission (found in a real browser)
    assert.equal(r.res.headers.get('referrer-policy'), 'same-origin');
    assert.match(r.text, /<meta name="referrer" content="same-origin">/);
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
    assert.match(r.res.headers.get('content-type'), /text\/html; charset=utf-8/);
    assertInert(r.text);
  });

  it('asks anonymous visitors to log in and shows a signed-in visitor the real form', async () => {
    const p = makePage();
    const anon = await view(p);
    assert.match(anon.text, new RegExp(`href="/auth/visitor/login\\?next=${encodeURIComponent(path(p)).replace(/[%]/g, '%')}"`));
    assert.ok(!anon.text.includes('name="f_name"'));
    const v = visitor();
    h.state.members.add(`${A}:${v.id}`);
    const signed = await view(p, v);
    assert.match(signed.text, /name="f_name"/);
    assert.ok(csrf(signed.text));
    assert.match(signed.text, /Signed in as <b>Vee<\/b>/);
  });

  it('members-only forms tell non-members why, without showing the form', async () => {
    const p = makePage({ form: { requireMember: true } });
    const r = await view(p, visitor());
    assert.match(r.text, /only for members of this server/);
    assert.ok(!r.text.includes('name="f_name"'));
  });

  it('rendering stays inert with hostile content and a hostile visitor name', async () => {
    const evil = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
    const p = makePage({ title: evil, blocks: [{ id: 'hero1', type: 'hero', data: { ...defaultBlockData('hero'), title: evil, subtitle: evil, imageUrl: 'javascript:alert(1)', buttonLabel: evil, buttonUrl: 'javascript:alert(1)' } }, formBlock({ title: evil, intro: evil, requireMember: false, fields: [question({ id: 'name', label: evil, type: 'short', placeholder: evil, help: evil })] })] });
    const v = visitor('900001', evil);
    assertInert((await view(p)).text);
    assertInert((await view(p, v)).text);
    const errored = await submit(p, v, { f_name: '' }, { member: false });
    assert.equal(errored.status, 422);
    assertInert(errored.text);
  });
});

describe('submitting a form', () => {
  it('saves the response, runs the flow with the answers, then thanks the visitor', async () => {
    const p = makePage();
    flowFor(p, 'GOT {{form.name}} / {{form.likes}} by {{user.name}} ({{user.id}}) resp={{response.id}} on {{page.title}} at {{page.url}}\n{{form.summary}}');
    const v = visitor('700001', 'Vee');
    const r = await submit(p, v, { f_name: 'Mia', f_likes: ['Tea', 'Coffee'] });
    assert.equal(r.status, 303);
    assert.equal(r.res.headers.get('location'), `${path(p)}/thanks?f=form1`);
    const [row] = responses(p);
    assert.deepEqual([row.userId, row.userName, row.answers], ['700001', 'Vee', { name: 'Mia', likes: ['Tea', 'Coffee'] }]);
    await settle();
    const line = logs().find((m) => m.startsWith('GOT'));
    assert.ok(line, logs().join(' | '));
    assert.match(line, /^GOT Mia \/ Tea, Coffee by visitor \(700001\) resp=\w{10} on Apply at http:\/\/localhost:3999\/s\/111111\/p\d+/);
    assert.match(line, /Name: Mia\nLikes: Tea, Coffee$/);
    const thanks = await h.call('GET', r.res.headers.get('location'), { sid: null });
    assert.equal(thanks.status, 200);
    assert.match(thanks.text, /All done!/);
    assertInert(thanks.text);
  });

  it('only starts the flow that is bound to this very form', async () => {
    const p = makePage();
    const other = makePage();
    flowFor(other, 'WRONG-FORM {{form.name}}');
    flowFor(p, 'RIGHT-FORM {{form.name}}');
    await submit(p, visitor(), { f_name: 'Mia' });
    await settle();
    assert.ok(logs().some((m) => m === 'RIGHT-FORM Mia'));
    assert.ok(!logs().some((m) => m.startsWith('WRONG-FORM')));
  });

  it('a flow in another server never sees the submission', async () => {
    const p = makePage();
    flowFor(p, 'LEAK {{form.name}}', { guildId: B });
    await submit(p, visitor(), { f_name: 'Mia' });
    await settle();
    assert.ok(!h.logger.recent(B).some((l) => l.message.startsWith('LEAK')));
  });

  it('shows validation errors, keeps what was typed and saves nothing', async () => {
    const p = makePage();
    flowFor(p, 'SHOULD-NOT-RUN');
    const r = await submit(p, visitor(), { f_name: '', f_likes: ['Nope'] });
    assert.equal(r.status, 422);
    assert.match(r.text, /This question is required\./);
    assert.match(r.text, /Choose only from the options shown\./);
    assert.match(r.text, /Please fix the highlighted answers\./);
    assert.equal(responses(p).length, 0);
    await settle();
    assert.ok(!logs().includes('SHOULD-NOT-RUN'));
    const again = await submit(p, visitor(), { f_name: 'a<b>' });
    assert.equal(again.status, 303);
  });

  it('needs a login, a valid one-time-per-form token, and a same-origin request', async () => {
    const p = makePage();
    const v = visitor();
    h.state.members.add(`${A}:${v.id}`);
    const good = csrf((await view(p, v)).text);
    const post = (over = {}) => h.call('POST', `${path(p)}/f/form1`, { sid: null, visitor: v.sid, form: { _csrf: good, f_name: 'Mia' }, ...over });
    assert.equal((await post({ visitor: undefined })).status, 401, 'not logged in');
    assert.equal((await post({ form: { f_name: 'Mia' } })).status, 403, 'no token');
    assert.equal((await post({ form: { _csrf: 'f'.repeat(64), f_name: 'Mia' } })).status, 403, 'wrong token');
    const other = visitor();
    h.state.members.add(`${A}:${other.id}`);
    assert.equal((await post({ visitor: other.sid })).status, 403, 'a token from another session');
    const p2 = makePage();
    assert.equal((await h.call('POST', `${path(p2)}/f/form1`, { sid: null, visitor: v.sid, form: { _csrf: good, f_name: 'Mia' } })).status, 403, 'a token from another page');
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403, 'cross-site');
    assert.equal((await post({ origin: null })).status, 403, 'no Origin and no Sec-Fetch-Site');
    assert.equal(responses(p).length, 0);
    assert.equal((await post()).status, 303);
    assert.equal(responses(p).length, 1);
  });

  it('members-only forms refuse non-members; open forms accept anyone signed in', async () => {
    const members = makePage({ form: { requireMember: true } });
    const denied = await submit(members, visitor('700010'), { f_name: 'Mia' }, { revokeMember: true });
    assert.equal(denied.status, 403);
    assert.match(denied.text, /only for members/);
    assert.equal(responses(members).length, 0);
    const open = makePage({ form: { requireMember: false } });
    flowFor(open, 'OPEN {{form.name}} {{user.name}}');
    const ok = await submit(open, visitor('700011', 'Outsider'), { f_name: 'Mia' }, { member: false });
    assert.equal(ok.status, 303);
    await settle();
    assert.ok(logs().includes('OPEN Mia Outsider'), 'the flow still knows who submitted');
  });

  it('one response per person', async () => {
    const p = makePage({ form: { oneResponsePerUser: true } });
    const v = visitor();
    const token = await tokenFor(p, v);
    assert.equal((await submit(p, v, { f_name: 'A' }, { token })).status, 303);
    const second = await submit(p, v, { f_name: 'B' }, { token }); // replaying the token: the server still enforces the rule
    assert.equal(second.status, 409);
    assert.match(second.text, /already sent a response/);
    assert.equal(responses(p).length, 1);
    assert.equal((await submit(p, visitor(), { f_name: 'C' })).status, 303, 'someone else can still answer');
    assert.match((await view(p, v)).text, /already sent a response/);
  });

  it('two simultaneous submissions cannot both slip past "one response per person"', async () => {
    const p = makePage({ form: { oneResponsePerUser: true } });
    const v = visitor();
    h.state.members.add(`${A}:${v.id}`);
    const token = csrf((await view(p, v)).text);
    const send = () => h.call('POST', `${path(p)}/f/form1`, { sid: null, visitor: v.sid, form: { _csrf: token, f_name: 'Mia' } });
    const results = await Promise.all([send(), send(), send(), send()]);
    assert.equal(results.filter((r) => r.status === 303).length, 1);
    assert.equal(responses(p).length, 1);
  });

  it('cooldown blocks a quick second response, then allows one later', async () => {
    const p = makePage({ form: { cooldownMinutes: 10 } });
    const v = visitor();
    const token = await tokenFor(p, v);
    assert.equal((await submit(p, v, { f_name: 'A' }, { token })).status, 303);
    assert.equal((await submit(p, v, { f_name: 'B' }, { token })).status, 409);
    h.db.db.prepare('UPDATE form_responses SET created_at = ? WHERE page_id = ?').run(Date.now() - 11 * 60000, p.id);
    assert.equal((await submit(p, v, { f_name: 'C' }, { token })).status, 303);
  });

  it('with saving switched off no answers are kept, but the flow runs and one-per-person still works (via a receipt)', async () => {
    const p = makePage({ form: { saveResponses: false, oneResponsePerUser: true } });
    flowFor(p, 'NOSAVE {{form.name}}');
    const v = visitor();
    const token = await tokenFor(p, v);
    assert.equal((await submit(p, v, { f_name: 'Secret' }, { token })).status, 303);
    await settle();
    assert.ok(logs().includes('NOSAVE Secret'));
    const [receipt] = responses(p);
    assert.deepEqual([receipt.userName, receipt.answers], ['', {}], 'who and when only — no name, no answers');
    assert.equal((await submit(p, v, { f_name: 'Again' }, { token })).status, 409);
    const plain = makePage({ form: { saveResponses: false } });
    assert.equal((await submit(plain, visitor(), { f_name: 'x' })).status, 303);
    assert.equal(responses(plain).length, 0, 'nothing at all is stored when no rule needs a receipt');
  });

  it('honours an optional cap on stored responses', async () => {
    const p = makePage();
    const first = visitor();
    const second = visitor();
    const t1 = await tokenFor(p, first);
    const t2 = await tokenFor(p, second);
    applyLimits({ responsesPerGuild: h.db.countResponsesInGuild(A) + 1 });
    assert.equal((await submit(p, first, { f_name: 'A' }, { token: t1 })).status, 303);
    const full = await submit(p, second, { f_name: 'B' }, { token: t2 });
    assert.equal(full.status, 409);
    assert.match(full.text, /not accepting more responses/);
  });

  it('redirect mode: a same-origin hop first, then a meta refresh to a validated address', async () => {
    const p = makePage({ form: { onSuccess: 'redirect', redirectUrl: 'https://example.com/welcome?x=1&y=2' } });
    const r = await submit(p, visitor(), { f_name: 'Mia' });
    assert.equal(r.status, 303);
    assert.ok(r.res.headers.get('location').startsWith('/s/'), 'never a cross-site redirect straight after a POST (the CSP form-action would block it)');
    const thanks = await h.call('GET', r.res.headers.get('location'), { sid: null });
    assert.match(thanks.text, /<meta http-equiv="refresh" content="0;url=https:\/\/example\.com\/welcome\?x=1&amp;y=2">/);
    assert.match(thanks.text, /href="https:\/\/example\.com\/welcome\?x=1&amp;y=2">Continue/);
    assertInert(thanks.text);
    const bad = makePage({ form: { onSuccess: 'redirect', redirectUrl: 'javascript:alert(1)' } }); // forced past validation
    const thanksBad = await h.call('GET', `${path(bad)}/thanks?f=form1`, { sid: null });
    assert.ok(!/http-equiv/.test(thanksBad.text));
    assert.ok(!/javascript:/.test(thanksBad.text));
  });

  it('cannot submit to a form that does not exist, is unpublished, or is in another server', async () => {
    const v = visitor();
    const live = makePage();
    const draft = makePage({ published: false });
    const foreign = makePage({ guildId: B });
    for (const [p, block] of [[live, 'nope'], [draft, 'form1'], [foreign, 'form1']]) {
      const url = p === foreign ? `/s/${A}/${foreign.slug}/f/${block}` : `${path(p)}/f/${block}`;
      const r = await h.call('POST', url, { sid: null, visitor: v.sid, form: { _csrf: 'x', f_name: 'Mia' } });
      assert.equal(r.status, 404, url);
    }
    assert.equal(responses(draft).length + responses(foreign).length, 0);
  });

  it('a very large body is refused', async () => {
    const p = makePage();
    const r = await submit(p, visitor(), { f_name: 'x'.repeat(300 * 1024) });
    assert.ok([413, 400].includes(r.status), String(r.status));
  });
});

describe('abuse limits on the public site', () => {
  it('slows a visitor who submits too fast', async () => {
    const strict = await startHarness({ config: { publicRate: { visitor: 3, ip: 1000, views: 1000 } } });
    try {
      strict.db.createPage({ guildId: A, slug: 'rl', title: 'RL', theme: {}, blocks: [formBlock({ requireMember: false })], published: true });
      const v = { id: 'rl1', sid: strict.visitorSession({ id: 'rl1', name: 'R', avatar: null }) };
      const token = (await strict.call('GET', `/s/${A}/rl`, { sid: null, visitor: v.sid })).text.match(/name="_csrf" value="([0-9a-f]{64})"/)[1];
      const statuses = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await strict.call('POST', `/s/${A}/rl/f/form1`, { sid: null, visitor: v.sid, form: { _csrf: token, f_name: '' } })).status);
      assert.deepEqual(statuses.slice(0, 3), [422, 422, 422]);
      assert.deepEqual(statuses.slice(3), [429, 429, 429]);
      assert.equal(strict.db.countResponsesInGuild(A), 0);
    } finally { await strict.close(); }
  });

  it('limits page views per address', async () => {
    const strict = await startHarness({ config: { publicRate: { views: 5, ip: 1000, visitor: 1000 } } });
    try {
      const codes = [];
      for (let i = 0; i < 8; i += 1) codes.push((await strict.call('GET', `/s/${A}/anything`, { sid: null })).status);
      assert.equal(codes.filter((c) => c === 429).length, 3);
    } finally { await strict.close(); }
  });
});
