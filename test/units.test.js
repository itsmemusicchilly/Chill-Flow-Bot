import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { CHANNEL_PERMISSIONS, COMMAND_PERMISSIONS, NODE_LIST, NODE_TYPES, ROLE_PERMISSIONS, availableVariables, defaultsFor, getOutputs, isTriggerType } from '../shared/catalog.js';
import { TEMPLATES } from '../shared/templates.js';
import { hasStructureErrors, normalizeGraph, validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { evalCondition, evalConditions } from '../server/engine/conditions.js';
import { executors } from '../server/engine/executors/index.js';
import { evaluate } from '../server/engine/expression.js';
import { RateLimiter, SelfActions } from '../server/engine/rate-limit.js';
import { safeRegexTest } from '../server/engine/safe-regex.js';
import { getPath, renderDeep, renderTemplate } from '../server/engine/template.js';
import { matches } from '../server/engine/triggers.js';
import { buildCustomId, parseCustomId } from '../server/engine/custom-id.js';
import { Logger } from '../server/logger.js';
import { edge, node } from './helpers/fakes.js';

describe('templates', () => {
  const scope = { user: { name: 'Mia' }, var: { n: 3, list: ['a', 'b'], obj: { x: 1 } } };
  it('renders values, arrays, objects and filters', () => {
    assert.equal(renderTemplate('Hi {{user.name}}!', scope), 'Hi Mia!');
    assert.equal(renderTemplate('{{ user.name | upper }}', scope), 'MIA');
    assert.equal(renderTemplate('{{var.list}}', scope), 'a, b');
    assert.equal(renderTemplate('{{var.list | length}}', scope), '2');
    assert.equal(renderTemplate('{{var.obj}}', scope), '{"x":1}');
    assert.equal(renderTemplate('{{var.missing | default:none}}', scope), 'none');
    assert.equal(renderTemplate('{{var.missing}}', scope), '');
  });
  it('never reaches prototypes, functions or inherited properties', () => {
    for (const p of ['constructor', '__proto__', 'user.constructor', 'user.__proto__.polluted', 'var.toString', 'user.name.constructor']) {
      assert.equal(renderTemplate(`[{{${p}}}]`, scope), '[]', p);
    }
    assert.equal(getPath({ a: 1 }, 'hasOwnProperty'), undefined);
  });
  it('is single-pass: substituted text is not evaluated again', () => {
    assert.equal(renderTemplate('{{user.name}}', { user: { name: '{{var.secret}}' }, var: { secret: 'S' } }), '{{var.secret}}');
  });
  it('renders deeply through arrays and objects only', () => {
    assert.deepEqual(renderDeep({ a: ['{{user.name}}', 5, { b: '{{var.n}}' }], c: true }, scope), { a: ['Mia', 5, { b: '3' }], c: true });
  });
});

describe('conditions, expressions, regex', () => {
  it('compares ignoring case, numerically when possible', () => {
    assert.ok(evalCondition('equals', 'Yes', 'yes'));
    assert.ok(evalCondition('equals', '5', '5.0'));
    assert.ok(evalCondition('gt', '10', '9'));
    assert.ok(!evalCondition('gt', 'abc', '1'));
    assert.ok(evalCondition('contains', 'Hello World', 'WORLD'));
    assert.ok(evalCondition('isEmpty', '  ', ''));
    assert.ok(evalCondition('matches', 'Order #123', '#\\d+'));
  });
  it('supports all/any', () => {
    const cs = [{ op: 'equals', left: 'a', right: 'a' }, { op: 'equals', left: 'a', right: 'b' }];
    assert.equal(evalConditions('all', cs), false);
    assert.equal(evalConditions('any', cs), true);
    assert.equal(evalConditions('any', []), false);
  });
  it('evaluates arithmetic without eval', () => {
    assert.equal(evaluate('2 + 3 * 4'), 14);
    assert.equal(evaluate('(2 + 3) * 4'), 20);
    assert.equal(evaluate('2 ^ 3 ^ 2'), 512);
    assert.equal(evaluate('-2 + max(1, 5) + round(1.5)'), 5);
    assert.throws(() => evaluate('1 / 0'));
    assert.throws(() => evaluate('process.exit(1)'));
    assert.throws(() => evaluate('1 +'));
    assert.throws(() => evaluate('9'.repeat(300)));
  });
  it('a catastrophic regex cannot freeze the process', () => {
    const t = Date.now();
    assert.equal(safeRegexTest('(a+)+$', `${'a'.repeat(40)}!`), false);
    assert.ok(Date.now() - t < 1000);
    assert.equal(safeRegexTest('^hel+o', 'Hello'), true);
    assert.equal(safeRegexTest('[', 'x'), false, 'invalid patterns are simply false');
    assert.equal(safeRegexTest('a'.repeat(500), 'a'), false, 'over-long patterns are rejected');
  });
});

describe('rate limiting and self-action tracking', () => {
  it('sliding window', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    assert.ok(rl.take('g') && rl.take('g'));
    assert.ok(!rl.take('g'));
    assert.ok(rl.take('other'));
    t = 1500;
    assert.ok(rl.take('g'));
  });
  it('self actions can be cancelled and expire', () => {
    let t = 0;
    const s = new SelfActions(100, () => t);
    const cancel = s.expect('k');
    cancel();
    assert.equal(s.consume('k'), false);
    s.expect('k');
    t = 200;
    assert.equal(s.consume('k'), false, 'expired');
  });
});

describe('custom ids', () => {
  it('round-trips and stays under Discord\'s 100 character limit', () => {
    const id = buildCustomId({ flowId: 'abcd1234', nodeId: 'node12345678', handle: 'btn_abc123', invokerId: '123456789012345678' });
    assert.ok(id.length <= 100);
    assert.deepEqual(parseCustomId(id), { flowId: 'abcd1234', nodeId: 'node12345678', handle: 'btn_abc123', invokerId: '123456789012345678' });
    assert.equal(parseCustomId('something:else'), null);
  });
});

describe('catalog integrity', () => {
  it('permission names exist in discord.js', () => {
    for (const p of [...CHANNEL_PERMISSIONS, ...ROLE_PERMISSIONS, ...COMMAND_PERMISSIONS]) assert.ok(p in PermissionFlagsBits, p);
  });
  it('every non-trigger node has an executor, and every executor has a node', () => {
    for (const d of NODE_LIST.filter((x) => !x.isTrigger)) assert.equal(typeof executors[d.type], 'function', `${d.type} has no executor`);
    for (const type of Object.keys(executors)) assert.ok(NODE_TYPES[type], `${type} executor has no catalog entry`);
  });
  it('definitions are well formed', () => {
    for (const d of NODE_LIST) {
      assert.ok(d.label && d.icon && d.category && d.description, d.type);
      const keys = d.fields.map((f) => f.key);
      assert.equal(new Set(keys).size, keys.length, `${d.type} has duplicate field keys`);
      for (const f of d.fields) {
        if (f.showIf) assert.ok(keys.includes(f.showIf.key), `${d.type}.${f.key} showIf refers to a missing field`);
        if (f.type === 'select') assert.ok(f.options.some((o) => o.value === f.default), `${d.type}.${f.key} default not in options`);
        if (f.type === 'list') {
          const item = f.item.create();
          for (const k of f.item.fields.map((x) => x.key)) assert.ok(k in item, `${d.type}.${f.key} item lacks ${k}`);
        }
      }
      assert.ok(getOutputs(d.type, defaultsFor(d.type)).length > 0, `${d.type} has no outputs`);
      if (d.requires) assert.ok(['members', 'messageContent'].includes(d.requires));
      assert.equal(isTriggerType(d.type), d.type.startsWith('trigger.'));
    }
  });
  it('trigger filters never crash on default data', () => {
    for (const d of NODE_LIST.filter((x) => x.isTrigger)) assert.doesNotThrow(() => matches(d.type, defaultsFor(d.type), {}), d.type);
  });
  it('dynamic outputs follow buttons and menu options', () => {
    const d = defaultsFor('action.message.send');
    d.buttons = [{ id: 'a', label: 'A', style: 'Primary' }, { id: 'l', label: 'L', style: 'Link' }];
    d.menuEnabled = true; d.menuOptions = [{ id: 'o1', label: 'One' }];
    assert.deepEqual(getOutputs('action.message.send', d).map((o) => o.id), ['out', 'btn_a', 'opt_o1', 'error']);
  });
  it('offers upstream variables to downstream nodes', () => {
    const nodes = [node('t', 'trigger.command', { name: 'x', options: [{ name: 'reason', description: 'r', type: 'string' }] }),
      node('c', 'action.channel.create', { name: 'a', outputVar: 'ticket' }), node('m', 'action.message.send', { buttons: [{ id: 'b', label: 'B', style: 'Primary' }] }),
      node('d', 'action.channel.delete')];
    const edges = [edge('t', 'c'), edge('c', 'm'), edge('m', 'd', 'btn_b')];
    const paths = availableVariables(nodes, edges, 'd').map((v) => v.path);
    for (const p of ['user.name', 'option.reason', 'var.ticket', 'original.user.name', 'guild.name']) assert.ok(paths.includes(p), p);
    assert.ok(!availableVariables(nodes, edges, 'c').map((v) => v.path).includes('original.user.name'));
  });
});

describe('graph validation', () => {
  const ok = (nodes, edges) => validateFlow(normalizeGraph({ nodes, edges }), { intents: { members: true, messageContent: true } });
  it('starter templates have no structural problems', () => {
    for (const t of TEMPLATES) {
      const issues = ok(t.build().nodes, t.build().edges);
      assert.ok(!hasStructureErrors(issues), `${t.id}: ${JSON.stringify(issues.filter((i) => i.kind === 'structure'))}`);
    }
  });
  it('rejects unknown types, dangling edges, edges into triggers, bad ids and dead handles', () => {
    const t = node('t', 'trigger.manual'); const s = node('s', 'action.message.send', { content: 'x' });
    assert.ok(hasStructureErrors(ok([{ ...t, type: 'nope' }], [])));
    assert.ok(hasStructureErrors(ok([t, s], [edge('t', 'zzz')])));
    assert.ok(hasStructureErrors(ok([t, s], [edge('s', 't')])));
    assert.ok(hasStructureErrors(ok([t, s], [edge('t', 's', 'btn_gone')])));
    assert.ok(hasStructureErrors(ok([t, { ...s, id: 'has space' }], [])));
    assert.ok(hasStructureErrors(ok([t, s], [edge('t', 't')])));
    assert.ok(!hasStructureErrors(ok([t, s], [edge('t', 's')])));
  });
  it('reports missing required fields and unreachable nodes as non-structural issues', () => {
    const issues = ok([node('t', 'trigger.command', { name: '', description: 'x' }), node('s', 'action.member.addRole', {})], [edge('t', 's')]);
    assert.ok(issues.some((i) => i.nodeId === 't' && /Command name/.test(i.message)));
    assert.ok(issues.some((i) => i.nodeId === 's' && /Role/.test(i.message)));
    assert.ok(!hasStructureErrors(issues));
    assert.ok(ok([node('t', 'trigger.manual'), node('l', 'logic.log', { message: 'x' })], []).some((i) => /never run/.test(i.message)));
  });
  it('validates command names and flags intents the operator has not enabled', () => {
    assert.ok(ok([node('t', 'trigger.command', { name: 'Bad Name!', description: 'x' })], []).some((i) => /lowercase/.test(i.message)));
    const noIntents = validateFlow(normalizeGraph({ nodes: [node('t', 'trigger.member.join')], edges: [] }), { intents: { members: false, messageContent: false } });
    assert.ok(noIntents.some((i) => i.kind === 'intent'));
  });
  it('normalisation drops editor-only keys', () => {
    const g = normalizeGraph({ nodes: [{ ...node('a', 'logic.wait'), selected: true, measured: { width: 1 }, dragging: true }], edges: [{ source: 'a', target: 'b', selected: true }] });
    assert.deepEqual(Object.keys(g.nodes[0]).sort(), ['data', 'id', 'position', 'type']);
    assert.equal(g.edges[0].sourceHandle, 'out');
  });
});

describe('database', () => {
  it('scopes flows by guild (no cross-server reads or writes)', () => {
    const db = new Database(':memory:');
    const f = db.createFlow({ guildId: 'A', name: 'a', graph: { nodes: [], edges: [] } });
    assert.equal(db.getFlow('B', f.id), null);
    assert.equal(db.updateFlow('B', f.id, { name: 'hacked' }), null);
    assert.equal(db.deleteFlow('B', f.id), false);
    assert.equal(db.getFlow('A', f.id).name, 'a');
    assert.deepEqual(db.listFlows('B'), []);
  });
  it('stores variables per server and enforces limits', () => {
    const db = new Database(':memory:');
    db.setVar('A', 'guild', '', 'x', { n: 1 });
    db.setVar('B', 'guild', '', 'x', 'other');
    assert.deepEqual(db.getVar('A', 'guild', '', 'x'), { n: 1 });
    assert.equal(db.getVar('B', 'guild', '', 'x'), 'other');
    assert.throws(() => db.setVar('A', 'global', '', 'x', 1), /scope/);
    assert.throws(() => db.setVar('A', 'guild', '', '../bad', 1), /valid variable name/);
    assert.throws(() => db.setVar('A', 'guild', '', 'big', 'x'.repeat(9000)), /at most/);
    assert.ok(db.deleteVar('A', 'guild', '', 'x'));
  });
  it('sessions are stored hashed and expire', () => {
    const db = new Database(':memory:');
    const id = db.createSession('u1', { hello: 1 }, 1000);
    assert.equal(db.getSession(id).userId, 'u1');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(id).n, 0, 'raw id is not stored');
    assert.equal(db.getSession('x'.repeat(64)), null);
    const old = db.createSession('u2', {}, -1);
    assert.equal(db.getSession(old), null);
  });
});

describe('logger', () => {
  it('keeps a bounded buffer per server and notifies subscribers of that server only', () => {
    const lg = new Logger({ perGuild: 3, console: false });
    const seen = [];
    const off = lg.subscribe('A', (e) => seen.push(e.message));
    for (let i = 0; i < 5; i += 1) lg.log('A', 'info', `m${i}`);
    lg.log('B', 'info', 'other');
    assert.deepEqual(lg.recent('A').map((e) => e.message), ['m2', 'm3', 'm4']);
    assert.deepEqual(seen.length, 5);
    assert.deepEqual(lg.recent('B').map((e) => e.message), ['other']);
    off();
    lg.log('A', 'info', 'after');
    assert.equal(seen.length, 5);
  });
});
