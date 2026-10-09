import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyNodeChanges, edgeChangeMatters, HISTORY_LIMIT, redo, remember, removedWithNode, sameSnap, snapFrom, undo } from '../web/src/history.js';

const graph = (nodes, edges = []) => ({ nodes, edges });
const node = (id, x = 0) => ({ id, type: 'logic.log', position: { x, y: 0 }, data: { message: id } });

describe('flow undo history', () => {
  it('returns the previous name and graph, and redo puts the edit back', () => {
    let history = { past: [], future: [] };
    const first = snapFrom('Welcome', graph([node('a')]));
    const second = snapFrom('Welcome', graph([node('a'), node('b', 40)]));
    history = remember(history, first);
    const back = undo(history, second);
    assert.equal(back.changed, true);
    assert.deepEqual(back.current, first);
    const forward = redo(back.history, back.current);
    assert.deepEqual(forward.current, second);
    assert.equal(undo(forward.history, forward.current).current.name, 'Welcome');
  });

  it('a repeated step and an empty history do nothing', () => {
    const snap = snapFrom('A', graph([node('a')]));
    const once = remember({ past: [], future: [] }, snap);
    assert.equal(remember(once, snap), once);
    assert.equal(undo({ past: [], future: [] }, snap).changed, false);
    assert.equal(redo({ past: [], future: [] }, snap).changed, false);
  });

  it('drops the oldest step past the limit, and a new edit clears redo', () => {
    let history = { past: [], future: [] };
    for (let i = 0; i < HISTORY_LIMIT + 3; i += 1) history = remember(history, snapFrom(String(i), graph([node('a')])));
    assert.equal(history.past.length, HISTORY_LIMIT);
    assert.equal(history.past[0].name, '3');
    const undone = undo(history, snapFrom('now', graph([node('a')])));
    assert.equal(undone.history.future.length, 1);
    const edited = remember(undone.history, snapFrom('fresh', graph([node('a')])));
    assert.equal(edited.future.length, 0);
  });

  it('treats a drag as one move and a delete’s leftover edges as not their own step', () => {
    assert.deepEqual(classifyNodeChanges([{ type: 'select', selected: true }]), { structural: false, positioning: false, dragging: false });
    assert.equal(classifyNodeChanges([{ type: 'position', dragging: true }]).dragging, true);
    assert.equal(classifyNodeChanges([{ type: 'position', dragging: false }]).dragging, false);
    assert.equal(classifyNodeChanges([{ type: 'remove' }]).structural, true);
    assert.equal(edgeChangeMatters([{ type: 'select' }]), false);
    assert.equal(edgeChangeMatters([{ type: 'remove', id: 'e1' }]), true);
    const edges = [{ id: 'e1', source: 'a', target: 'b' }];
    assert.equal(removedWithNode([{ type: 'remove', id: 'e1' }], edges, ['b']), true);
    assert.equal(removedWithNode([{ type: 'remove', id: 'e1' }], edges, ['a', 'b']), false);
  });

  it('ignores selection and display fields when comparing', () => {
    const a = snapFrom('A', graph([{ ...node('a'), selected: true, measured: { width: 10 } }]));
    const b = snapFrom('A', graph([node('a')]));
    assert.equal(sameSnap(a, b), true);
  });
});
