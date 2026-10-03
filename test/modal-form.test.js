// Show Form: the kinds of question (text, dropdown, member / role / channel picker, file upload), their settings and their checks.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { availableVariables, defaultsFor, NODE_TYPES } from '../shared/catalog.js';
import { isVisible } from '../shared/fields.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { edge, node } from './helpers/fakes.js';

const def = NODE_TYPES['action.modal.show'];
const itemFields = def.fields.find((f) => f.key === 'inputs').item.fields;
const fresh = () => def.fields.find((f) => f.key === 'inputs').item.create();
const q = (over = {}) => ({ ...fresh(), id: 'a', label: 'Question', ...over });
const problems = (...inputs) => def.check({ title: 'T', inputs });
const shown = (item) => itemFields.filter((f) => isVisible(f, item)).map((f) => f.key);
const choices = (n) => Array.from({ length: n }, (_, i) => ({ label: `Choice ${i + 1}`, value: `c${i + 1}`, description: '', default: false }));

describe('Show Form — what each kind of question asks for', () => {
  it('a new question is a text question, as before', () => {
    const item = fresh();
    assert.equal(item.kind, 'text');
    assert.deepEqual(shown(item), ['id', 'label', 'kind', 'description', 'style', 'placeholder', 'defaultValue', 'minLength', 'maxLength', 'required']);
  });

  it('a question saved before there were kinds (no `kind`) still shows the text settings and is valid', () => {
    const old = { id: 'topic', label: 'Topic', style: 'paragraph', placeholder: 'Say…', required: true, maxLength: 200 };
    assert.deepEqual(shown(old), ['id', 'label', 'kind', 'description', 'style', 'placeholder', 'defaultValue', 'minLength', 'maxLength', 'required']);
    assert.deepEqual(problems(old), []);
    const g = normalizeGraph({ nodes: [{ id: 'f', type: 'action.modal.show', position: { x: 0, y: 0 }, data: { title: 'T', inputs: [old] } }], edges: [] });
    assert.deepEqual(g.nodes[0].data.inputs, [old], 'it is left exactly as it was');
    assert.deepEqual(validateFlow({ nodes: [node('t', 'trigger.command', { name: 'x', description: 'd' }), { ...g.nodes[0] }], edges: [edge('t', 'f')] }).filter((i) => i.level === 'error'), []);
  });

  it('a dropdown shows its choices and how many may be picked, not the text settings', () => {
    assert.deepEqual(shown(q({ kind: 'select' })), ['id', 'label', 'kind', 'description', 'placeholder', 'options', 'maxChoices', 'required']);
  });

  it('the member, role and channel pickers show a placeholder and how many', () => {
    for (const kind of ['user', 'role', 'channel']) assert.deepEqual(shown(q({ kind })), ['id', 'label', 'kind', 'description', 'placeholder', 'maxChoices', 'required'], kind);
  });

  it('a file upload has no placeholder', () => {
    assert.deepEqual(shown(q({ kind: 'file' })), ['id', 'label', 'kind', 'description', 'maxChoices', 'required']);
  });

  it('offers all six kinds', () => {
    assert.deepEqual(itemFields.find((f) => f.key === 'kind').options.map((o) => o.value), ['text', 'select', 'user', 'role', 'channel', 'file']);
  });

  it('a form still holds at most 5 questions, and a dropdown at most 25 choices', () => {
    assert.equal(def.fields.find((f) => f.key === 'inputs').max, 5);
    assert.equal(itemFields.find((f) => f.key === 'options').max, 25);
  });
});

describe('Show Form — checks', () => {
  it('a good dropdown, picker and file question pass', () => {
    assert.deepEqual(problems(q({ id: 'a', kind: 'select', options: choices(3), maxChoices: 2 }), q({ id: 'b', kind: 'role' }), q({ id: 'c', kind: 'file', maxChoices: 10 })), []);
  });

  it('a dropdown needs at least one choice', () => {
    assert.match(problems(q({ kind: 'select', options: [] }))[0], /needs at least one choice/);
  });

  it('two choices may not share a value', () => {
    const [m] = problems(q({ kind: 'select', options: [{ label: 'A', value: 'x' }, { label: 'B', value: 'x' }] }));
    assert.match(m, /choice #2 repeats the value “x”/);
  });

  it('“how many” cannot be more than the number of choices', () => {
    assert.match(problems(q({ kind: 'select', options: choices(2), maxChoices: 3 }))[0], /“How many” \(3\) is more than the number of choices \(2\)/);
    assert.deepEqual(problems(q({ kind: 'select', options: choices(2), maxChoices: 2 })), []);
  });

  it('at most 10 files', () => {
    assert.match(problems(q({ kind: 'file', maxChoices: 11 }))[0], /at most 10 files/);
  });

  it('the minimum length cannot be more than the maximum', () => {
    assert.match(problems(q({ minLength: 50, maxLength: 10 }))[0], /minimum length cannot be more than the maximum/);
    assert.deepEqual(problems(q({ minLength: 10, maxLength: 10 })), []);
    assert.deepEqual(problems(q({ minLength: 10 })), [], 'only one of them is fine');
  });

  it('an unknown kind is refused', () => {
    assert.match(problems(q({ kind: 'slider' }))[0], /unknown type/);
  });

  it('numbers that are templates are not judged here', () => {
    assert.deepEqual(problems(q({ minLength: '{{var.min}}', maxLength: 5 })), []);
    assert.deepEqual(problems(q({ kind: 'select', options: choices(2), maxChoices: '{{var.n}}' })), []);
  });

  it('the old rules still hold: an ID is required in shape and unique', () => {
    assert.match(problems(q({ id: '9bad' }))[0], /must be letters, numbers or _/);
    assert.match(problems(q({ id: 'a' }), q({ id: 'a' }))[0], /Duplicate input ID/);
    assert.match(def.check({ title: 'T', inputs: [] })[0], /Add at least one input/);
  });

  it('the generic field checks reach the choices: 26 are too many, and a choice needs its label and value', () => {
    const issues = validateFlow({
      nodes: [node('t', 'trigger.command', { name: 'x', description: 'd' }), node('f', 'action.modal.show', { title: 'T', inputs: [q({ kind: 'select', options: [...choices(25), { label: '', value: '' }] })] })],
      edges: [edge('t', 'f')],
    }).map((i) => i.message).join('\n');
    assert.match(issues, /at most 25 items/);
    assert.match(issues, /“Label shown” is required/);
    assert.match(issues, /“Value \(what \{\{input\.ID\}\} becomes\)” is required/);
  });
});

describe('Show Form — what later nodes are offered', () => {
  const vars = (inputs) => availableVariables([node('t', 'trigger.command', { name: 'x', description: 'd' }), node('f', 'action.modal.show', { title: 'T', inputs }), node('r', 'action.message.send', { content: 'x' })], [edge('t', 'f'), edge('f', 'r', 'submit')], 'r').filter((v) => v.path.startsWith('input.'));

  it('says what each kind of answer is', () => {
    const got = Object.fromEntries(vars([q({ id: 'name' }), q({ id: 'color', label: 'Color', kind: 'select' }), q({ id: 'who', label: 'Who', kind: 'user' }), q({ id: 'rl', label: 'Role', kind: 'role' }), q({ id: 'ch', label: 'Channel', kind: 'channel' }), q({ id: 'proof', label: 'Proof', kind: 'file' })]).map((v) => [v.path, v.label]));
    assert.deepEqual(got, {
      'input.name': 'Answer: Question', 'input.color': 'Answer: Color (chosen value(s))', 'input.who': 'Answer: Who (picked member ID(s))',
      'input.rl': 'Answer: Role (picked role ID(s))', 'input.ch': 'Answer: Channel (picked channel ID(s))', 'input.proof': 'Answer: Proof (uploaded file link(s))',
    });
  });

  it('the default node is still a valid starting point', () => {
    const d = defaultsFor('action.modal.show');
    assert.equal(d.title, 'Tell us more');
    assert.deepEqual(d.inputs, []);
  });
});
