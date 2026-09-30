// A connection is "this output of this node leads to that node". Two edges with the same source, output and target are the
// same connection — the validator rejects a duplicate, and the editor treats connecting the same pair twice as "undo".

/** The identity of a connection (its id can differ, e.g. in an imported flow). */
export const connectionKey = (e) => `${e.source}|${e.sourceHandle || 'out'}|${e.target}`;

/**
 * What dragging a connection from `c.source` (output `c.sourceHandle`) to `c.target` does to a flow's edges:
 * it connects them, or — when they are already connected — disconnects them again.
 * @returns {{edges: object[], removed: boolean}} a new edge list (the input is not changed)
 */
export function toggleConnection(edges, c) {
  const key = connectionKey(c);
  if (edges.some((e) => connectionKey(e) === key)) return { edges: edges.filter((e) => connectionKey(e) !== key), removed: true };
  const sourceHandle = c.sourceHandle || 'out';
  return { edges: [...edges, { id: `${c.source}:${sourceHandle}>${c.target}`, source: c.source, sourceHandle, target: c.target, targetHandle: 'in' }], removed: false };
}
