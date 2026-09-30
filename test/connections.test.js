// Connecting two things that are already connected disconnects them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectionKey, toggleConnection } from '../shared/connections.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { edge, node } from './helpers/fakes.js';

const drag = (source, target, sourceHandle = 'out') => ({ source, sourceHandle, target, targetHandle: 'in' });

describe('toggleConnection', () => {
  it('connects two things that are not connected yet', () => {
    const { edges, removed } = toggleConnection([], drag('a', 'b'));
    assert.equal(removed, false);
    assert.deepEqual(edges, [{ id: 'a:out>b', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }]);
  });

  it('connecting the same pair again disconnects them', () => {
    const once = toggleConnection([], drag('a', 'b')).edges;
    const twice = toggleConnection(once, drag('a', 'b'));
    assert.equal(twice.removed, true);
    assert.deepEqual(twice.edges, []);
    assert.equal(toggleConnection(twice.edges, drag('a', 'b')).removed, false, 'and a third time connects them again');
  });

  it('a different output or a different target is a different connection', () => {
    const base = [edge('a', 'b')];
    const other = toggleConnection(base, drag('a', 'b', 'error'));
    assert.equal(other.removed, false);
    assert.equal(other.edges.length, 2, 'the error output of the same node may lead to the same target');
    assert.equal(toggleConnection(base, drag('a', 'c')).edges.length, 2);
    assert.equal(toggleConnection(base, drag('x', 'b')).edges.length, 2);
    assert.equal(toggleConnection(other.edges, drag('a', 'b', 'error')).edges.length, 1, 'each is undone on its own');
  });

  it('only removes that connection, and keeps everything else in order', () => {
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('c', 'd'), edge('a', 'b', 'btn_1')];
    const { edges: after, removed } = toggleConnection(edges, drag('a', 'c'));
    assert.equal(removed, true);
    assert.deepEqual(after.map((e) => e.id), ['a:out>b', 'c:out>d', 'a:btn_1>b']);
  });

  it('recognises a connection by what it joins, not by its id (imported flows have their own ids)', () => {
    const imported = [{ id: 'my-own-id', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }];
    const { edges, removed } = toggleConnection(imported, drag('a', 'b'));
    assert.equal(removed, true);
    assert.deepEqual(edges, []);
  });

  it('treats a missing output name as the default output, like the validator does', () => {
    assert.equal(connectionKey({ source: 'a', target: 'b' }), connectionKey({ source: 'a', sourceHandle: 'out', target: 'b' }));
    assert.equal(toggleConnection([edge('a', 'b')], { source: 'a', sourceHandle: null, target: 'b' }).removed, true);
  });

  it('does not change the list it is given', () => {
    const edges = Object.freeze([Object.freeze(edge('a', 'b'))]);
    assert.doesNotThrow(() => toggleConnection(edges, drag('a', 'b')));
    assert.doesNotThrow(() => toggleConnection(edges, drag('a', 'c')));
    assert.equal(edges.length, 1);
  });

  it('never produces the duplicate connection the server refuses', () => {
    const nodes = [node('t', 'trigger.command', { name: 'go', description: 'go' }), node('m', 'logic.log', { message: 'hi' })];
    let edges = [];
    for (let i = 0; i < 5; i += 1) {
      edges = toggleConnection(edges, drag('t', 'm')).edges;
      const duplicates = validateFlow(normalizeGraph({ nodes, edges })).filter((x) => /Duplicate connection/.test(x.message));
      assert.deepEqual(duplicates, [], `after ${i + 1} drags`);
      assert.equal(edges.length, (i + 1) % 2);
    }
  });

  it('the validator still refuses a real duplicate', () => {
    const nodes = [node('t', 'trigger.command', { name: 'go', description: 'go' }), node('m', 'logic.log', { message: 'hi' })];
    const issues = validateFlow(normalizeGraph({ nodes, edges: [edge('t', 'm'), { ...edge('t', 'm'), id: 'another-id' }] }));
    assert.ok(issues.some((i) => /Duplicate connection/.test(i.message)));
  });
});
