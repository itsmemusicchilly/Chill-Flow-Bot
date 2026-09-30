// Maths in text: {{value | add:1 | commas}} and friends.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { availableVariables } from '../shared/catalog.js';
import { resetLimits } from '../shared/limits.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { renderTemplate } from '../server/engine/template.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

const scope = {
  var: { five: 5, ten: '10', text: 'hello', big: 1234567.891, neg: -7.5, zero: 0, tenth: 0.1, fifth: 0.2, list: [1, 2], yes: true },
  guild: { vars: { joins: 41 }, memberCount: 1204 },
  user: { name: 'mia' },
};
const r = (t) => renderTemplate(t, scope);

describe('maths filters', () => {
  it('add, sub, mul, div, mod, min and max', () => {
    assert.equal(r('{{guild.vars.joins | add:1}}'), '42');
    assert.equal(r('{{var.five | sub:8}}'), '-3');
    assert.equal(r('{{var.five | mul:4}}'), '20');
    assert.equal(r('{{var.five | div:2}}'), '2.5');
    assert.equal(r('{{var.ten | mod:4}}'), '2', 'numbers stored as text work too');
    assert.equal(r('{{var.five | min:3}}'), '3');
    assert.equal(r('{{var.five | max:9}}'), '9');
  });

  it('abs, floor, ceil and round (with an optional number of decimals)', () => {
    assert.equal(r('{{var.neg | abs}}'), '7.5');
    assert.equal(r('{{var.neg | floor}}'), '-8');
    assert.equal(r('{{var.neg | ceil}}'), '-7');
    assert.equal(r('{{var.big | round}}'), '1234568');
    assert.equal(r('{{var.big | round:1}}'), '1234567.9');
    assert.equal(r('{{var.big | round:2}}'), '1234567.89');
    assert.equal(r('{{var.neg | round}}'), '-7', 'Math.round semantics: halves go up');
  });

  it('commas and fixed give text you can show', () => {
    assert.equal(r('{{guild.memberCount | commas}}'), '1,204');
    assert.equal(r('{{var.big | commas}}'), '1,234,567.891');
    assert.equal(r('{{var.neg | commas}}'), '-7.5');
    assert.equal(r('{{var.five | fixed:2}}'), '5.00', 'fixed keeps trailing zeros');
    assert.equal(r('{{var.five | fixed}}'), '5.00', 'two decimals by default');
    assert.equal(r('{{var.big | fixed:0}}'), '1234568');
    assert.equal(r('{{var.five | round:2}}'), '5', 'round does not');
  });

  it('chains left to right', () => {
    assert.equal(r('{{guild.vars.joins | add:1 | mul:2 | sub:4 | commas}}'), '80');
    assert.equal(r('Members: {{guild.vars.joins | default:0 | add:1 | commas}}'), 'Members: 42');
    assert.equal(r('{{var.big | mul:1000 | round | commas}}'), '1,234,567,891');
  });

  it('a missing or empty value counts as 0, like Add on a variable', () => {
    assert.equal(r('{{var.nothing | add:1}}'), '1');
    assert.equal(r('{{guild.vars.nothing | add:1 | commas}}'), '1');
    assert.equal(r('{{var.zero | add:1}}'), '1');
    assert.equal(renderTemplate('{{x | add:1}}', { x: '' }), '1');
    assert.equal(renderTemplate('{{x | add:1}}', { x: null }), '1');
    assert.equal(r('{{var.nothing | round}}'), '0');
  });

  it('takes a variable as the second value', () => {
    assert.equal(r('{{var.five | add:var.ten}}'), '15');
    assert.equal(r('{{guild.vars.joins | mul:var.five}}'), '205');
    assert.equal(r('{{var.five | add:var.nothing}}'), '5', 'a missing second value counts as 0');
    assert.equal(r('{{var.five | add: var.five }}'), '10', 'spaces do not matter');
  });

  it('leaves what it cannot calculate as it was', () => {
    assert.equal(r('{{var.text | add:1}}'), 'hello', 'not a number');
    assert.equal(r('{{var.list | add:1}}'), '1, 2', 'a list is not a number');
    assert.equal(r('{{var.yes | add:1}}'), 'true', 'nor is true');
    assert.equal(r('{{var.five | div:0}}'), '5', 'dividing by zero');
    assert.equal(r('{{var.five | mod:0}}'), '5');
    assert.equal(r('{{var.five | div:var.zero}}'), '5');
    assert.equal(r('{{var.text | commas}}'), 'hello');
    assert.equal(r('{{var.text | fixed:2}}'), 'hello');
    assert.equal(renderTemplate('{{x | mul:10}}', { x: 1e308 }), String(1e308), 'a result too big to be a number');
    assert.equal(renderTemplate('{{x | add:1}}', { x: 'Infinity' }), 'Infinity');
  });

  it('tidies floating point noise', () => {
    assert.equal(r('{{var.tenth | add:var.fifth}}'), '0.3');
    assert.equal(r('{{var.tenth | mul:3}}'), '0.3');
    assert.equal(r('{{var.five | div:3 | round:2}}'), '1.67');
    assert.equal(r('{{var.neg | mul:0}}'), '0', 'no negative zero');
  });

  it('keeps the existing filters working next to it', () => {
    assert.equal(r('{{user.name | upper}}'), 'MIA');
    assert.equal(r('{{var.nothing | default:none}}'), 'none');
    assert.equal(r('{{var.nothing | default:0 | add:5}}'), '5');
    assert.equal(r('{{user.name | length | add:1}}'), '4');
    assert.equal(r('{{var.text | nosuchfilter}}'), 'hello', 'an unknown filter still does nothing');
  });

  it('stays safe: arguments only read own properties, values are not re-evaluated', () => {
    assert.equal(r('{{var.five | add:constructor}}'), '5');
    assert.equal(r('{{var.five | add:__proto__}}'), '5');
    assert.equal(r('{{var.five | add:var.constructor.length}}'), '5');
    const nasty = { x: '{{secret}}', secret: 'leak' };
    assert.equal(renderTemplate('{{x | add:1}}', nasty), '{{secret}}', 'a value that looks like a template is left alone');
    assert.equal(renderTemplate('{{x | commas}}', nasty), '{{secret}}');
  });

  it('clamps the number of decimals', () => {
    assert.equal(r('{{var.five | fixed:99}}'), '5.0000000000');
    assert.equal(r('{{var.five | fixed:-3}}'), '5');
    assert.equal(r('{{var.five | fixed:abc}}'), '5.00');
  });
});


// ---- the Math block --------------------------------------------------------------------------------------------------------
describe('the Math block', () => {
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

  /** /calc → Math → a reply saying `say`; if the maths fails, a reply with the error text. */
  const calc = (mathData, say = 'result={{var.total}}') => {
    for (const f of db.listFlows(guild.id)) db.deleteFlow(guild.id, f.id); // one /calc at a time: the first flow with a command wins
    db.createFlow({
      guildId: guild.id, name: 'Calc',
      graph: commandFlow(
        [node('m', 'data.math', { saveAs: 'total', ...mathData }), node('ok', 'action.message.send', { target: 'reply', content: say }), node('bad', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })],
        [edge('t', 'm'), edge('m', 'ok'), edge('m', 'bad', 'error')], 'calc',
      ),
    });
    runtime.loadGuild(guild.id);
  };
  const run = async (u = user, m = member) => {
    const i = fakeCommand({ guild, channel, user: u, member: m, commandName: 'calc' });
    await runtime.handleInteraction(i);
    return i.calls[0][1].content;
  };
  const two = (a, op, b, extra = {}) => ({ mode: 'two', a, op, b, ...extra });

  it('does every operation on two values', async () => {
    for (const [a, op, b, want] of [['7', 'add', '5', '12'], ['7', 'sub', '10', '-3'], ['6', 'mul', '7', '42'], ['9', 'div', '4', '2.25'], ['9', 'mod', '4', '1'], ['2', 'pow', '10', '1024'], ['3', 'min', '8', '3'], ['3', 'max', '8', '8']]) {
      calc(two(a, op, b));
      assert.equal(await run(), `result=${want}`, `${a} ${op} ${b}`);
    }
  });

  it('takes its values from variables, the member count or options', async () => {
    db.setVar(guild.id, 'guild', '', 'joins', 41);
    calc(two('{{guild.vars.joins}}', 'add', '1'));
    assert.equal(await run(), 'result=42');
    calc(two('{{guild.memberCount}}', 'mul', '2'));
    assert.equal(await run(), 'result=6');
  });

  it('a blank value counts as 0, so the very first run does not fail', async () => {
    calc(two('{{guild.vars.never_set}}', 'add', '1'));
    assert.equal(await run(), 'result=1');
    calc(two('', 'add', ''));
    assert.equal(await run(), 'result=0');
  });

  it('a formula uses brackets, functions and values from anywhere', async () => {
    db.setVar(guild.id, 'guild', '', 'a', 3);
    db.setVar(guild.id, 'guild', '', 'b', 4);
    calc({ mode: 'formula', formula: '({{guild.vars.a}} + {{guild.vars.b}}) * 2' });
    assert.equal(await run(), 'result=14');
    calc({ mode: 'formula', formula: 'max({{guild.vars.a}}, 10) + round(2.6) - abs(-1)' });
    assert.equal(await run(), 'result=12');
  });

  it('rounds when asked, and tidies floating point noise', async () => {
    calc(two('10', 'div', '3', { round: 'none' }), 'r={{var.total}}');
    assert.equal(await run(), 'r=3.33333333333');
    calc(two('10', 'div', '3', { round: '0' }), 'r={{var.total}}');
    assert.equal(await run(), 'r=3');
    calc(two('10', 'div', '3', { round: '1' }), 'r={{var.total}}');
    assert.equal(await run(), 'r=3.3');
    calc(two('2', 'div', '3', { round: '2' }), 'r={{var.total}}');
    assert.equal(await run(), 'r=0.67');
    calc(two('0.1', 'add', '0.2'), 'r={{var.total}}');
    assert.equal(await run(), 'r=0.3');
  });

  it('a problem follows the On error output with a message that says what to do', async () => {
    calc(two('abc', 'add', '1'));
    assert.match(await run(), /failed: “abc” is not a number/);
    calc(two('5', 'div', '0'));
    assert.match(await run(), /failed: Cannot divide by zero/);
    calc(two('5', 'mod', '0'));
    assert.match(await run(), /failed: Cannot divide by zero/);
    calc(two('10', 'pow', '1000'));
    assert.match(await run(), /failed: The result is not a finite number/);
    calc({ mode: 'formula', formula: '{{guild.vars.never_set}} * 5' });
    assert.match(await run(), /failed: .*default:0/, 'an empty variable in a formula is explained');
    calc({ mode: 'formula', formula: '{{guild.vars.never_set}} + 5' });
    assert.equal(await run(), 'result=5', 'before a + or - an empty variable simply acts like 0');
    calc({ mode: 'formula', formula: '1 / 0' });
    assert.match(await run(), /failed: Division by zero/);
    calc(two('1', 'nope', '1'));
    assert.match(await run(), /failed: Unknown operation/);
  });

  it('can also remember the result as a server variable (and counts on from it)', async () => {
    calc(two('{{guild.vars.joins}}', 'add', '1', { remember: 'guild', saveAs: 'joins' }), 'joins={{var.joins}} stored={{guild.vars.joins}}');
    assert.equal(await run(), 'joins=1 stored=1');
    assert.equal(await run(), 'joins=2 stored=2');
    assert.equal(await run(), 'joins=3 stored=3');
    assert.equal(db.getVar(guild.id, 'guild', '', 'joins'), 3);
    assert.equal(db.getVar('999999', 'guild', '', 'joins'), undefined, 'another server has nothing');
  });

  it('or as a per-user variable: for the person who triggered it, or for someone named', async () => {
    calc(two('{{user.vars.coins}}', 'add', '5', { remember: 'user', saveAs: 'coins' }), 'c={{var.coins}}');
    assert.equal(await run(), 'c=5');
    assert.equal(await run(), 'c=10');
    assert.equal(db.getVar(guild.id, 'user', '222222', 'coins'), 10);
    const other = fakeUser({ id: '333333', username: 'sam' });
    assert.equal(await run(other, guild.addMember({ user: other })), 'c=5', 'someone else starts from their own 0');
    calc(two('100', 'add', '1', { remember: 'user', saveAs: 'bank', targetId: '444444' }), 'b={{var.bank}}');
    assert.equal(await run(), 'b=101');
    assert.equal(db.getVar(guild.id, 'user', '444444', 'bank'), 101, 'stored for the user that was named');
  });

  it('a run-only result is not remembered', async () => {
    calc(two('1', 'add', '1'), 'r={{var.total}}');
    assert.equal(await run(), 'r=2');
    assert.deepEqual(db.listVars(guild.id), []);
  });

  it('offers its result as a variable to the nodes after it', () => {
    const nodes = [node('t', 'trigger.command', { name: 'calc', description: 'x' }), node('m', 'data.math', { saveAs: 'total', a: '1', b: '2' }), node('s', 'action.message.send', { target: 'reply', content: 'x' })];
    const paths = availableVariables(nodes, [edge('t', 'm'), edge('m', 's')], 's').map((v) => v.path);
    assert.ok(paths.includes('var.total'));
    assert.equal(availableVariables(nodes, [edge('t', 'm'), edge('m', 's')], 'm').some((v) => v.path === 'var.total'), false, 'not before it exists');
  });

  it('checks its own settings while you build', () => {
    const problems = (data) => validateFlow(normalizeGraph({
      nodes: [node('t', 'trigger.command', { name: 'calc', description: 'x' }), node('m', 'data.math', data)], edges: [edge('t', 'm')],
    })).filter((i) => i.nodeId === 'm' && i.level === 'error').map((i) => i.message).join(' | ');
    assert.match(problems({ mode: 'two', a: '', b: '', saveAs: 'total' }), /First value.*required[\s\S]*Second value.*required/);
    assert.match(problems({ mode: 'two', a: '1', b: '2', saveAs: '' }), /Save result as.*required/);
    assert.match(problems({ mode: 'two', a: '1', b: '2', saveAs: '9bad name' }), /Save result as/);
    assert.match(problems({ mode: 'formula', formula: '', saveAs: 'total' }), /Formula.*required/);
    assert.equal(problems({ mode: 'formula', formula: '1+1', saveAs: 'total', a: '', b: '' }), '', 'the two-value fields do not matter in formula mode');
    assert.equal(problems({ mode: 'two', a: '1', b: '2', saveAs: 'total' }), '');
  });
});
