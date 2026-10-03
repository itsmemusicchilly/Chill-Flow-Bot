// Show Form at run time: the modal Discord is sent for each kind of question, and how the answers come back as {{input.<id>}}.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ModalBuilder } from 'discord.js';
import { resetLimits } from '../shared/limits.js';
import { Database } from '../server/db.js';
import { FlowError } from '../server/engine/errors.js';
import { buildQuestion, readAnswer } from '../server/engine/form.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeComponent, fakeGuild, fakeUser, node } from './helpers/fakes.js';

const json = (q) => JSON.parse(JSON.stringify(buildQuestion(q).toJSON()));
const base = (over = {}) => ({ id: 'q', label: 'Question', required: true, ...over });
const choices = [{ label: 'Red', value: 'red', description: 'Warm', default: false }, { label: 'Blue', value: 'blue', description: '', default: true }, { label: 'Green', value: 'green' }];

describe('the component built for each kind of question', () => {
  it('text: a question saved before kinds existed is built exactly as before, plus the label wrapper', () => {
    const c = json(base({ style: 'paragraph', placeholder: 'Say…', maxLength: 200 }));
    assert.deepEqual(c, { type: 18, label: 'Question', component: { type: 4, custom_id: 'in_q', style: 2, placeholder: 'Say…', max_length: 200, required: true } });
  });

  it('text: help line, minimum length, pre-filled text, optional', () => {
    const c = json(base({ kind: 'text', description: 'Be brief', minLength: 5, maxLength: 50, defaultValue: 'Hello', required: false }));
    assert.equal(c.description, 'Be brief');
    assert.deepEqual(c.component, { type: 4, custom_id: 'in_q', style: 1, min_length: 5, max_length: 50, value: 'Hello', required: false });
  });

  it('text: sizes are cut to what Discord allows, and a minimum above the maximum is lowered to it', () => {
    const c = json(base({ label: 'L'.repeat(80), description: 'd'.repeat(300), placeholder: 'p'.repeat(300), maxLength: 9000, defaultValue: 'v'.repeat(9000), minLength: 8000 }));
    assert.equal(c.label.length, 45);
    assert.equal(c.description.length, 100);
    assert.equal(c.component.placeholder.length, 100);
    assert.deepEqual([c.component.max_length, c.component.min_length, c.component.value.length], [4000, 4000, 4000]);
    const lowered = json(base({ minLength: 50, maxLength: 10 }));
    assert.equal(lowered.component.min_length, 10);
  });

  it('dropdown: choices, descriptions, the pre-selected one, and how many may be picked', () => {
    const c = json(base({ kind: 'select', options: choices, maxChoices: 2, placeholder: 'Pick' })).component;
    assert.equal(c.type, 3);
    assert.deepEqual([c.min_values, c.max_values, c.placeholder, c.required], [1, 2, 'Pick', true]);
    assert.deepEqual(c.options, [
      { label: 'Red', value: 'red', description: 'Warm', default: false },
      { label: 'Blue', value: 'blue', default: true },
      { label: 'Green', value: 'green', default: false },
    ]);
  });

  it('dropdown: optional means nothing has to be picked; the most is never more than the choices; at most as many pre-selected as may be picked', () => {
    const c = json(base({ kind: 'select', required: false, maxChoices: 99, options: choices.map((o) => ({ ...o, default: true })) })).component;
    assert.deepEqual([c.min_values, c.max_values, c.required], [0, 3, false]);
    const one = json(base({ kind: 'select', options: choices.map((o) => ({ ...o, default: true })) })).component;
    assert.equal(one.options.filter((o) => o.default).length, 1, 'one pick allowed, so one pre-selected');
  });

  it('dropdown: long texts are cut, choices without a value are dropped, 25 at most', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: 'x'.repeat(200), value: `v${i}`, description: 'd'.repeat(200) }));
    const c = json(base({ kind: 'select', options: [{ label: 'nothing', value: ' ' }, ...many], placeholder: 'p'.repeat(400) })).component;
    assert.equal(c.options.length, 25);
    assert.deepEqual([c.options[0].label.length, c.options[0].description.length, c.placeholder.length], [100, 100, 150]);
    assert.ok(c.options.every((o) => o.value.startsWith('v')));
  });

  it('dropdown: no choices is an error, not an empty menu', () => {
    assert.throws(() => buildQuestion(base({ kind: 'select', options: [] })), (e) => e instanceof FlowError && /no choices/.test(e.message));
    assert.throws(() => buildQuestion(base({ kind: 'select' })), FlowError);
  });

  it('member, role and channel pickers', () => {
    const types = { user: 5, role: 6, channel: 8 };
    for (const [kind, type] of Object.entries(types)) {
      const c = json(base({ kind, maxChoices: 3, placeholder: 'Choose' })).component;
      assert.deepEqual([c.type, c.min_values, c.max_values, c.placeholder, c.required, c.custom_id], [type, 1, 3, 'Choose', true, 'in_q'], kind);
      assert.deepEqual(json(base({ kind, required: false })).component.min_values, 0, `${kind} optional`);
      assert.equal(json(base({ kind, maxChoices: 99 })).component.max_values, 25, `${kind} at most 25`);
      assert.equal(json(base({ kind })).component.max_values, 1, `${kind} one by default`);
    }
  });

  it('file upload: how many files, optional, at most 10', () => {
    assert.deepEqual(json(base({ kind: 'file', maxChoices: 3 })).component, { type: 19, custom_id: 'in_q', min_values: 1, max_values: 3, required: true });
    assert.deepEqual(json(base({ kind: 'file', required: false, maxChoices: 50 })).component, { type: 19, custom_id: 'in_q', min_values: 0, max_values: 10, required: false });
  });

  it('an unknown kind is an error that names the question', () => {
    assert.throws(() => buildQuestion(base({ kind: 'slider', label: 'Mood' })), /“Mood” has an unknown type “slider”/);
  });

  it('a whole mixed form is valid as far as discord.js can tell', () => {
    const modal = new ModalBuilder().setCustomId('fcm:1:f').setTitle('Everything');
    modal.addLabelComponents([
      base({ id: 'a' }), base({ id: 'b', kind: 'select', options: choices }), base({ id: 'c', kind: 'user' }), base({ id: 'd', kind: 'role', required: false }), base({ id: 'e', kind: 'file' }),
    ].map(buildQuestion));
    const out = modal.toJSON();
    assert.equal(out.components.length, 5);
    assert.deepEqual(out.components.map((c) => c.component.type), [4, 3, 5, 6, 19]);
  });
});

describe('reading the answers', () => {
  const coll = (entries) => new Map(entries);
  const fields = {
    getTextInputValue: (id) => ({ in_t: 'hello', in_empty: '' })[id],
    getStringSelectValues: (id) => ({ in_one: ['red'], in_many: ['red', 'blue'], in_none: [] })[id],
    getSelectedUsers: (id) => ({ in_u: coll([['111', {}], ['222', {}]]), in_nou: null })[id] ?? null,
    getSelectedRoles: (id) => ({ in_r: coll([['333', {}]]) })[id] ?? null,
    getSelectedChannels: (id) => ({ in_c: coll([['444', {}]]) })[id] ?? null,
    getUploadedFiles: (id) => ({ in_f: coll([['9', { url: 'https://cdn.discordapp.com/a.png' }], ['10', { url: 'https://cdn.discordapp.com/b.pdf' }]]) })[id] ?? null,
  };
  const ask = (q) => readAnswer({ label: 'Q', ...q }, fields);

  it('text is what was typed (also for a question that has no kind)', () => {
    assert.equal(ask({ id: 't' }), 'hello');
    assert.equal(ask({ id: 't', kind: 'text' }), 'hello');
    assert.equal(ask({ id: 'empty', required: false }), '');
  });
  it('a dropdown gives the chosen values, joined with a comma and a space', () => {
    assert.equal(ask({ id: 'one', kind: 'select' }), 'red');
    assert.equal(ask({ id: 'many', kind: 'select' }), 'red, blue');
    assert.equal(ask({ id: 'none', kind: 'select', required: false }), '');
  });
  it('the pickers give the picked IDs', () => {
    assert.equal(ask({ id: 'u', kind: 'user' }), '111, 222');
    assert.equal(ask({ id: 'r', kind: 'role' }), '333');
    assert.equal(ask({ id: 'c', kind: 'channel' }), '444');
    assert.equal(ask({ id: 'nou', kind: 'user', required: false }), '', 'nobody picked');
  });
  it('a file upload gives the links', () => {
    assert.equal(ask({ id: 'f', kind: 'file' }), 'https://cdn.discordapp.com/a.png, https://cdn.discordapp.com/b.pdf');
    assert.equal(ask({ id: 'nof', kind: 'file', required: false }), '');
  });
  it('an optional question that was not sent at all is empty; a required one that is missing is an error', () => {
    const strict = { getTextInputValue() { throw new Error('field not found'); } };
    assert.equal(readAnswer({ id: 'x', required: false }, strict), '');
    assert.throws(() => readAnswer({ id: 'x' }, strict), /field not found/);
  });
});

describe('Show Form in a flow', () => {
  let db; let runtime; let guild; let channel; let user; let member;
  beforeEach(() => {
    resetLimits();
    db = new Database(':memory:');
    runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
    guild = fakeGuild({ id: '111111' });
    channel = guild.addChannel({ name: 'general' });
    user = fakeUser({ id: '222222', username: 'mia' });
    member = guild.addMember({ user });
    runtime.attachClient(guild.client);
  });
  const install = (inputs, reply) => {
    db.createFlow({ guildId: guild.id, name: 'f', graph: commandFlow([node('m', 'action.modal.show', { title: 'Feedback', inputs }), node('r', 'action.message.send', { target: 'reply', content: reply }), node('bad', 'action.message.send', { target: 'reply', content: 'FAILED {{error.message}}' })], [edge('t', 'm'), edge('m', 'r', 'submit'), edge('m', 'bad', 'error')]) });
    runtime.loadGuild(guild.id);
  };
  const run = async (fields) => {
    const i = fakeCommand({ guild, channel, user, member, commandName: 'cmd', options: [] });
    i.showModal = async (modal) => { i.calls.push(['showModal', JSON.parse(JSON.stringify(modal.toJSON()))]); };
    const submit = fakeComponent({ guild, channel, user, member, customId: 'x' });
    submit.isMessageComponent = () => false;
    submit.isModalSubmit = () => true;
    submit.isFromMessage = () => false;
    submit.fields = fields;
    i.awaitModalSubmit = async () => submit;
    await runtime.handleInteraction(i);
    return { i, submit };
  };

  it('shows every kind of question, and hands the answers on as {{input.<id>}}', async () => {
    install([
      { id: 'name', label: 'Name', required: true },
      { id: 'color', label: 'Color', kind: 'select', options: choices, maxChoices: 2 },
      { id: 'who', label: 'Who', kind: 'user' },
      { id: 'role', label: 'Role', kind: 'role' },
      { id: 'where', label: 'Where', kind: 'channel', required: false },
    ], 'name={{input.name}} color={{input.color}} who={{input.who}} role={{input.role}} where=[{{input.where}}]');
    const { i, submit } = await run({
      getTextInputValue: () => 'Mia', getStringSelectValues: () => ['red', 'blue'], getSelectedUsers: () => new Map([['700', {}]]),
      getSelectedRoles: () => new Map([['800', {}]]), getSelectedChannels: () => null, getUploadedFiles: () => null,
    });
    const modal = i.calls.find((c) => c[0] === 'showModal')[1];
    assert.equal(modal.title, 'Feedback');
    assert.deepEqual(modal.components.map((c) => [c.label, c.component.type]), [['Name', 4], ['Color', 3], ['Who', 5], ['Role', 6], ['Where', 8]]);
    assert.equal(submit.calls[0][1].content, 'name=Mia color=red, blue who=700 role=800 where=[]');
  });

  it('an uploaded file arrives as its link', async () => {
    install([{ id: 'proof', label: 'Proof', kind: 'file' }], 'file={{input.proof}}');
    const { submit } = await run({ getUploadedFiles: () => new Map([['1', { url: 'https://cdn.discordapp.com/x.png' }]]) });
    assert.equal(submit.calls[0][1].content, 'file=https://cdn.discordapp.com/x.png');
  });

  it('follows the error output, and leaves the interaction unanswered, when a question cannot be built', async () => {
    install([{ id: 'color', label: 'Color', kind: 'select', options: [] }], 'never');
    const i = fakeCommand({ guild, channel, user, member, commandName: 'cmd', options: [] });
    let shown = false;
    i.showModal = async () => { shown = true; };
    await runtime.handleInteraction(i);
    assert.equal(shown, false, 'no form was opened');
    const said = i.calls.find((c) => c[0] === 'reply' || c[0] === 'editReply')[1].content;
    assert.match(said, /^FAILED Question “Color” has no choices/);
  });
});
