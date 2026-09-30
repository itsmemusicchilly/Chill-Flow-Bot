// The embeds of Send Message / Edit Message: the current `embeds` list, the older flat keys, and moving from one to the other.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultsFor, NODE_TYPES } from '../shared/catalog.js';
import { blankEmbed, embedChars, embedsOf, MAX_EMBEDS, upgradeMessageData } from '../shared/embeds.js';
import { normalizeGraph } from '../shared/validate.js';

const legacy = (extra = {}) => ({
  target: 'channel', useEmbed: true, embedTitle: 'Hello', embedDescription: 'Body', embedColor: '#ff8800', embedThumbnail: 'https://x.example/t.png',
  embedImage: 'upload:0123456789abcdef', embedFooter: 'Foot', embedTimestamp: true, embedFields: [{ name: 'A', value: '1', inline: true }], ...extra,
});

describe('embedsOf — one way to read either shape', () => {
  it('turns the older flat keys into one embed, and leaves a missing colour as “no colour”', () => {
    const [e, ...rest] = embedsOf(legacy());
    assert.equal(rest.length, 0);
    assert.deepEqual({ ...e, id: undefined }, {
      id: undefined, title: 'Hello', url: '', description: 'Body', color: '#ff8800', authorName: '', authorIcon: '', authorUrl: '', thumbnail: 'https://x.example/t.png',
      image: 'upload:0123456789abcdef', footer: 'Foot', footerIcon: '', timestamp: true, fields: [{ name: 'A', value: '1', inline: true }],
    });
    assert.equal(embedsOf({ useEmbed: true, embedTitle: 'x' })[0].color, '');
  });

  it('has no embed when the old switch is off, or nothing is there', () => {
    assert.deepEqual(embedsOf(legacy({ useEmbed: false })), []);
    assert.deepEqual(embedsOf({}), []);
    assert.deepEqual(embedsOf(undefined), []);
  });

  it('returns the list of the current shape as it is', () => {
    const embeds = [{ ...blankEmbed(), title: 'One' }, { ...blankEmbed(), title: 'Two' }];
    assert.equal(embedsOf({ embeds }), embeds);
  });

  it('is not fooled by the empty list that catalog defaults put next to old flat keys', () => {
    assert.equal(embedsOf({ ...defaultsFor('action.message.send'), ...legacy() })[0].title, 'Hello');
  });
});

describe('upgradeMessageData — rewriting old nodes to the current shape', () => {
  it('moves the flat embed keys of Send Message into the list, and does it only once', () => {
    const once = upgradeMessageData('action.message.send', legacy());
    assert.equal(once.embeds.length, 1);
    assert.equal(once.embeds[0].title, 'Hello');
    for (const k of ['useEmbed', 'embedTitle', 'embedDescription', 'embedColor', 'embedThumbnail', 'embedImage', 'embedFooter', 'embedTimestamp', 'embedFields']) assert.ok(!(k in once), k);
    assert.equal(once.target, 'channel', 'everything else is kept');
    assert.equal(upgradeMessageData('action.message.send', once), once, 'a second pass changes nothing (and returns the same object)');
  });

  it('gives a node whose old switch was off an empty list', () => {
    assert.deepEqual(upgradeMessageData('action.message.send', legacy({ useEmbed: false })).embeds, []);
  });

  it('leaves alone nodes that have nothing old in them, and nodes of other types', () => {
    const fresh = defaultsFor('action.message.send');
    assert.equal(upgradeMessageData('action.message.send', fresh), fresh);
    const other = { embedTitle: 'not a message node' };
    assert.equal(upgradeMessageData('logic.log', other), other);
  });

  it('writes down what an Edit Message saved before the choices always did', () => {
    const withEmbed = upgradeMessageData('action.message.edit', { messageId: '123456789012345678', content: 'new', ...legacy() });
    assert.equal(withEmbed.contentMode, 'replace');
    assert.equal(withEmbed.embedsMode, 'replace');
    assert.equal(withEmbed.messageFrom, 'id');
    assert.equal(withEmbed.embeds[0].title, 'Hello');
    const noEmbed = upgradeMessageData('action.message.edit', { messageId: '123456789012345678', content: 'new', useEmbed: false });
    assert.equal(noEmbed.embedsMode, 'remove', 'it used to take a missing embed off');
    assert.equal(upgradeMessageData('action.message.edit', { content: 'x' }).messageFrom, 'this', 'no ID: it used the triggering message');
  });

  it('keeps the choices a new Edit Message already has', () => {
    const fresh = defaultsFor('action.message.edit');
    assert.deepEqual([fresh.contentMode, fresh.embedsMode, fresh.messageFrom], ['keep', 'keep', 'this']);
    assert.equal(upgradeMessageData('action.message.edit', fresh), fresh);
  });

  it('works out “which message” for a Change Buttons node saved before that choice', () => {
    assert.equal(upgradeMessageData('action.message.buttons', { mode: 'clear', messageId: '123456789012345678' }).messageFrom, 'id');
    assert.equal(upgradeMessageData('action.message.buttons', { mode: 'clear', messageId: '' }).messageFrom, 'this');
    const chosen = { mode: 'clear', messageFrom: 'this', messageId: '123' };
    assert.equal(upgradeMessageData('action.message.buttons', chosen), chosen);
  });

  it('is applied to every saved graph', () => {
    const graph = normalizeGraph({ nodes: [{ id: 'm', type: 'action.message.send', position: { x: 0, y: 0 }, data: legacy() }], edges: [] });
    assert.equal(graph.nodes[0].data.embeds[0].description, 'Body');
    assert.ok(!('useEmbed' in graph.nodes[0].data));
  });
});

describe('the embed editor in the catalog', () => {
  const embedsField = (type) => NODE_TYPES[type].fields.find((f) => f.key === 'embeds');

  it('offers up to 10 embeds, each with every part, on Send Message and Edit Message', () => {
    for (const type of ['action.message.send', 'action.message.edit']) {
      const f = embedsField(type);
      assert.equal(f.max, MAX_EMBEDS, type);
      assert.deepEqual(f.item.fields.map((x) => x.key), ['title', 'url', 'description', 'color', 'authorName', 'authorIcon', 'authorUrl', 'thumbnail', 'image', 'footer', 'footerIcon', 'timestamp', 'fields'], type);
      const created = f.item.create();
      for (const part of f.item.fields) assert.ok(part.key in created, `${type}: a new embed has “${part.key}”`);
      assert.equal(f.item.fields.find((x) => x.key === 'fields').max, 25);
    }
  });

  it('a new embed starts empty, with the usual colour and its own id each time', () => {
    const a = blankEmbed();
    const b = blankEmbed();
    assert.notEqual(a.id, b.id);
    assert.deepEqual({ ...a, id: '' }, { id: '', title: '', url: '', description: '', color: '#5865f2', authorName: '', authorIcon: '', authorUrl: '', thumbnail: '', image: '', footer: '', footerIcon: '', timestamp: false, fields: [] });
  });

  it('counts the characters Discord counts', () => {
    assert.equal(embedChars({ title: 'abc', description: 'de', author: { name: 'f' }, footer: { text: 'gh' }, fields: [{ name: 'i', value: 'jk' }] }), 3 + 2 + 1 + 2 + 1 + 2);
    assert.equal(embedChars({}), 0);
  });
});

describe('what the editor says is wrong with the embeds', () => {
  const send = NODE_TYPES['action.message.send'];
  const edit = NODE_TYPES['action.message.edit'];
  const embed = (o) => ({ ...blankEmbed(), title: 'T', ...o });

  it('an author icon or link needs an author name, and a footer icon needs footer text', () => {
    assert.match(send.check({ content: 'x', embeds: [embed({ authorIcon: 'https://x.example/a.png' })] })[0], /author needs a name/);
    assert.match(send.check({ content: 'x', embeds: [embed({ authorUrl: 'https://x.example' })] })[0], /author needs a name/);
    assert.match(send.check({ content: 'x', embeds: [embed({ footerIcon: 'https://x.example/f.png' })] })[0], /footer icon needs footer text/);
    assert.deepEqual(send.check({ content: 'x', embeds: [embed({ authorName: 'Team', authorIcon: 'https://x.example/a.png', footer: 'F', footerIcon: 'https://x.example/f.png' })] }), []);
  });

  it('links must be http(s), but a {{variable}} is fine', () => {
    assert.match(send.check({ content: 'x', embeds: [embed({ url: 'ftp://x.example' })] })[0], /title link must start with http/);
    assert.match(send.check({ content: 'x', embeds: [embed({ authorName: 'A', authorUrl: 'nope' })] })[0], /author link must start with http/);
    assert.deepEqual(send.check({ content: 'x', embeds: [embed({ url: '{{var.link}}' })] }), []);
  });

  it('names the embed when there are several, and stops at ten', () => {
    const bad = send.check({ content: 'x', embeds: [embed(), embed({ footerIcon: 'https://x.example/f.png' })] });
    assert.match(bad[0], /^Embed 2: /);
    assert.match(send.check({ content: 'x', embeds: Array.from({ length: 11 }, () => embed()) })[0], /at most 10 embeds/);
  });

  it('an embed alone is enough for Send Message, in either shape', () => {
    assert.deepEqual(send.check({ embeds: [embed()] }), []);
    assert.deepEqual(send.check({ useEmbed: true, embedTitle: 'Old style' }), []);
    assert.match(send.check({})[0], /Add message text, an embed or buttons/);
  });

  it('Edit Message says when there is nothing to change, or nothing chosen to change', () => {
    assert.match(edit.check({ contentMode: 'keep', embedsMode: 'keep' })[0], /Nothing to change/);
    assert.deepEqual(edit.check({ contentMode: 'replace', embedsMode: 'keep' }), []);
    assert.match(edit.check({ contentMode: 'keep', embedsMode: 'patch', patchSet: [], patchRemove: [] })[0], /parts of the embed to set or remove/);
    assert.deepEqual(edit.check({ contentMode: 'keep', embedsMode: 'patch', patchSet: [], patchRemove: ['footer'] }), []);
    assert.match(edit.check({ contentMode: 'keep', embedsMode: 'replace', embeds: [embed({ footerIcon: 'https://x.example/f.png' })] })[0], /footer icon needs footer text/);
  });

  it('Edit Message summarises what it will do', () => {
    assert.equal(edit.summary({ contentMode: 'keep', embedsMode: 'keep', messageFrom: 'this' }), 'nothing to change — this message');
    assert.equal(edit.summary({ contentMode: 'replace', embedsMode: 'patch', messageFrom: 'id', messageId: '{{var.msg}}' }), 'replace text, change an embed — {{var.msg}}');
    assert.equal(edit.summary({ contentMode: 'remove', embedsMode: 'remove', messageFrom: 'id', messageId: '' }), 'remove text, remove embeds — (ID needed)');
  });
});
