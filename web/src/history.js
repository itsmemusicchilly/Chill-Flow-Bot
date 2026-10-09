// Undo steps for the flow editor. A step is the name plus the nodes and edges, without selection.

export const HISTORY_LIMIT = 50;

export function snapFrom(name, graph) {
  return JSON.parse(JSON.stringify({
    name,
    nodes: graph.nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
    edges: graph.edges.map(({ id, source, sourceHandle, target }) => ({ id, source, sourceHandle: sourceHandle || 'out', target })),
  }));
}

export const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Keep `snap` as something Undo can return to. A repeat of the newest step is ignored. */
export function remember(history, snap, limit = HISTORY_LIMIT) {
  if (history.past.length && sameSnap(history.past[history.past.length - 1], snap)) return history;
  const past = [...history.past, snap];
  if (past.length > limit) past.splice(0, past.length - limit);
  return { past, future: [] };
}

export function undo(history, current) {
  if (!history.past.length) return { history, current, changed: false };
  const previous = history.past[history.past.length - 1];
  return {
    history: { past: history.past.slice(0, -1), future: [current, ...history.future] },
    current: previous,
    changed: true,
  };
}

export function redo(history, current) {
  if (!history.future.length) return { history, current, changed: false };
  const [next, ...future] = history.future;
  return {
    history: { past: [...history.past, current], future },
    current: next,
    changed: true,
  };
}

/** Which node changes are an edit, and which are the middle of a drag (one step for the whole drag). */
export function classifyNodeChanges(changes) {
  const structural = changes.some((c) => c.type === 'remove' || c.type === 'add' || c.type === 'replace');
  const positioning = changes.some((c) => c.type === 'position');
  const dragging = changes.some((c) => c.type === 'position' && c.dragging === true);
  return { structural, positioning, dragging };
}

export function edgeChangeMatters(changes) {
  return changes.some((c) => c.type === 'remove' || c.type === 'add' || c.type === 'replace');
}

/** Edge removals that only tidy up after a node was deleted are not their own undo step. */
export function removedWithNode(changes, edges, nodeIds) {
  if (!changes.length || changes.some((c) => c.type !== 'remove')) return false;
  const ids = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
  return changes.every((c) => {
    const edge = edges.find((e) => e.id === c.id);
    return Boolean(edge) && (!ids.has(edge.source) || !ids.has(edge.target));
  });
}
