import {
  applyEdgeChanges, applyNodeChanges, Background, Controls, MarkerType, MiniMap, ReactFlow, useNodesInitialized, useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultsFor, getOutputs, isTriggerType, NODE_TYPES, nodeTitle } from '@shared/catalog.js';
import { classifyNodeChanges, edgeChangeMatters, redo as redoHistory, remember, removedWithNode, sameSnap, snapFrom, undo as undoHistory } from '../history.js';
import { localTimeZone } from '@shared/cron.js';
import { PHONE, useMediaQuery } from '../hooks/useMediaQuery.js';
import { toggleConnection } from '@shared/connections.js';
import { LIMITS } from '@shared/limits.js';
import { uid } from '@shared/util.js';
import { upgradeNodeData } from '@shared/upgrade.js';
import { normalizeGraph, validateFlow } from '@shared/validate.js';
import { api } from '../api.js';
import { EditorContext, useToast } from '../context.js';
import FlowNode from './FlowNode.jsx';
import Inspector from './Inspector.jsx';

const nodeTypes = Object.fromEntries(Object.keys(NODE_TYPES).map((t) => [t, FlowNode]));

function edgeColor(handle = 'out') {
  if (handle === 'error') return '#ed4245';
  if (handle === 'true' || handle === 'ok') return '#3ba55d';
  if (handle === 'false' || handle === 'blocked') return '#f0b232';
  if (handle.startsWith('btn_') || handle.startsWith('opt_') || handle === 'submit') return '#7983f5';
  if (handle === 'each') return '#f97316';
  return '#8e9297';
}

/** First position near `start` (scanning a small grid) where a new node would not sit on top of another. */
function freeSpot(nodes, start) {
  const W = 290;
  const H = 170;
  const taken = (x, y) => nodes.some((n) => Math.abs(n.position.x - x) < W && Math.abs(n.position.y - y) < H);
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const x = start.x + col * W;
      const y = start.y + row * H;
      if (!taken(x, y)) return { x, y };
    }
  }
  return start;
}

const plain = (g) => ({
  nodes: g.nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
  edges: g.edges.map(({ id, source, sourceHandle, target }) => ({ id, source, sourceHandle: sourceHandle || 'out', target })),
});

export default function FlowWorkspace({ gid, flow, meta, accounts, guildData, flash, apiRef, dirtyRef, onSaved, onToggle }) {
  const toast = useToast();
  const rf = useReactFlow();
  const phone = useMediaQuery(PHONE);
  const wrapRef = useRef(null);
  // Nodes saved in an older shape (one embed as flat keys, Edit Message without its choices) are shown — and saved next time — in the current one.
  const [graph, setGraph] = useState(() => ({ nodes: flow.graph.nodes.map((n) => ({ ...n, data: upgradeNodeData(n.type, n.data) })), edges: flow.graph.edges.map((e) => ({ ...e })) }));
  const [name, setName] = useState(flow.name);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [steps, setSteps] = useState({ undo: 0, redo: 0 });
  const graphRef = useRef(graph);
  const nameRef = useRef(name);
  const historyRef = useRef({ past: [], future: [] });
  const savedRef = useRef(null);
  const dragBaseline = useRef(null);
  const nameBaseline = useRef(null);
  graphRef.current = graph;
  nameRef.current = name;
  if (savedRef.current === null) savedRef.current = snapFrom(flow.name, graph);

  // Fit the whole flow into view once every node has been measured (the `fitView` prop can fire too early).
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (!initialized || fitted.current) return;
    fitted.current = true;
    // A wide flow fitted into a phone screen is too small to read: start at its first trigger instead, at a readable size, and let the person pan.
    const box = wrapRef.current?.getBoundingClientRect();
    const nodes = rf.getNodes();
    const span = nodes.length ? Math.max(...nodes.map((n) => n.position.x + (n.measured?.width ?? 264))) - Math.min(...nodes.map((n) => n.position.x)) : 0;
    if (phone && box && span * 0.7 > box.width) {
      const first = [...nodes].sort((a, b) => (isTriggerType(b.type) - isTriggerType(a.type)) || (a.position.x - b.position.x))[0];
      rf.setViewport({ x: 16 - first.position.x * 0.75, y: 40 - first.position.y * 0.75, zoom: 0.75 });
    } else rf.fitView({ maxZoom: 0.9, padding: 0.25 });
  }, [initialized, rf]); // eslint-disable-line react-hooks/exhaustive-deps

  const markDirty = useCallback(() => { setDirty(true); dirtyRef.current = true; }, [dirtyRef]);
  const capture = () => snapFrom(nameRef.current, graphRef.current);
  const syncSteps = () => setSteps({ undo: historyRef.current.past.length, redo: historyRef.current.future.length });
  const setDirtyTo = (snap) => {
    const on = !sameSnap(snap, savedRef.current);
    setDirty(on);
    dirtyRef.current = on;
  };
  const showSnap = (snap) => {
    const selected = new Set(graphRef.current.nodes.filter((n) => n.selected).map((n) => n.id));
    const nodes = snap.nodes.map((n) => ({ ...n, position: { ...n.position }, data: n.data, selected: selected.has(n.id) }));
    const edges = snap.edges.map((e) => ({ ...e }));
    graphRef.current = { nodes, edges };
    nameRef.current = snap.name;
    setGraph(graphRef.current);
    setName(snap.name);
    setDirtyTo(snap);
  };
  // The name and a drag each count as one step, finished on blur or when the pointer goes up.
  const commitName = () => {
    if (!nameBaseline.current) return;
    const before = nameBaseline.current;
    nameBaseline.current = null;
    if (!sameSnap(before, capture())) {
      historyRef.current = remember(historyRef.current, before);
      syncSteps();
    }
  };
  const commitDrag = () => {
    if (!dragBaseline.current) return;
    const before = dragBaseline.current;
    dragBaseline.current = null;
    if (!sameSnap(before, capture())) {
      historyRef.current = remember(historyRef.current, before);
      syncSteps();
    }
  };
  const checkpoint = () => {
    commitName();
    commitDrag();
    historyRef.current = remember(historyRef.current, capture());
    syncSteps();
  };
  const undo = () => {
    commitName();
    commitDrag();
    const step = undoHistory(historyRef.current, capture());
    historyRef.current = step.history;
    if (step.changed) showSnap(step.current);
    syncSteps();
  };
  const redo = () => {
    commitName();
    commitDrag();
    const step = redoHistory(historyRef.current, capture());
    historyRef.current = step.history;
    if (step.changed) showSnap(step.current);
    syncSteps();
  };
  const edit = useRef({});
  edit.current = { checkpoint, undo, redo, commitDrag, commitName };
  useEffect(() => { dirtyRef.current = false; return () => { dirtyRef.current = false; }; }, [dirtyRef]);
  useEffect(() => {
    const warn = (e) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyRef]);

  // ---- validation (same rules as the server) ---------------------------------------------------
  const issues = useMemo(() => validateFlow(normalizeGraph(graph), { intents: meta.intents, integrations: meta.integrations, accounts }), [graph, meta.intents, meta.integrations, accounts]);
  const issuesByNode = useMemo(() => {
    const map = {};
    for (const i of issues) if (i.nodeId) (map[i.nodeId] ||= []).push(i);
    return map;
  }, [issues]);
  const errorCount = issues.filter((i) => i.level === 'error').length;

  // ---- graph editing ---------------------------------------------------------------------------
  const onNodesChange = useCallback((changes) => {
    const { structural, positioning, dragging } = classifyNodeChanges(changes);
    const nextNodes = applyNodeChanges(changes, graphRef.current.nodes);
    if (dragging && !dragBaseline.current) {
      edit.current.commitName();
      dragBaseline.current = snapFrom(nameRef.current, graphRef.current);
    } else if (!dragging && (structural || positioning)) {
      const baseline = dragBaseline.current;
      dragBaseline.current = null;
      if (!baseline) edit.current.commitName();
      const before = baseline ?? snapFrom(nameRef.current, graphRef.current);
      const next = { ...graphRef.current, nodes: nextNodes };
      if (!sameSnap(before, snapFrom(nameRef.current, next))) {
        historyRef.current = remember(historyRef.current, before);
        setSteps({ undo: historyRef.current.past.length, redo: historyRef.current.future.length });
      }
    }
    graphRef.current = { ...graphRef.current, nodes: nextNodes };
    setGraph(graphRef.current);
    if (structural || positioning) markDirty();
  }, [markDirty]);
  const onEdgesChange = useCallback((changes) => {
    const nextEdges = applyEdgeChanges(changes, graphRef.current.edges);
    const nodeIds = new Set(graphRef.current.nodes.map((n) => n.id));
    const record = edgeChangeMatters(changes) && !removedWithNode(changes, graphRef.current.edges, nodeIds);
    if (record) edit.current.checkpoint();
    graphRef.current = { ...graphRef.current, edges: nextEdges };
    setGraph(graphRef.current);
    if (record) markDirty();
  }, [markDirty]);
  // Dragging a connection between two things that are already connected removes it: connecting twice undoes the first.
  const onConnect = useCallback((c) => {
    const { edges, removed } = toggleConnection(graphRef.current.edges, c);
    edit.current.checkpoint();
    graphRef.current = { ...graphRef.current, edges };
    setGraph(graphRef.current);
    markDirty();
    if (removed) toast('Connection removed.', 'info');
  }, [markDirty, toast]);
  const isValidConnection = useCallback((c) => {
    const target = graphRef.current.nodes.find((n) => n.id === c.target);
    return c.source !== c.target && Boolean(target) && !isTriggerType(target.type);
  }, []);

  const patchNode = useCallback((id, patch) => {
    const g = graphRef.current;
    const nodes = g.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
    const target = nodes.find((n) => n.id === id);
    const valid = new Set(getOutputs(target.type, target.data).map((o) => o.id));
    // a removed button/option must not leave a dangling connection behind
    const next = { nodes, edges: g.edges.filter((e) => e.source !== id || valid.has(e.sourceHandle || 'out')) };
    if (sameSnap(snapFrom(nameRef.current, g), snapFrom(nameRef.current, next))) return;
    edit.current.checkpoint();
    graphRef.current = next;
    setGraph(next);
    markDirty();
  }, [markDirty]);

  const freshId = () => {
    const taken = new Set(graphRef.current.nodes.map((n) => n.id));
    let id = uid(6);
    while (taken.has(id)) id = uid(6);
    return id;
  };

  const addNode = useCallback((type, position) => {
    if (graphRef.current.nodes.length >= LIMITS.nodesPerFlow) { toast(`A flow can have at most ${LIMITS.nodesPerFlow} nodes.`, 'error'); return; }
    let pos = position;
    if (!pos) {
      const box = wrapRef.current?.getBoundingClientRect();
      const center = rf.screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 600) / 2 - 130, y: (box?.top ?? 0) + (box?.height ?? 400) / 3 });
      pos = freeSpot(graphRef.current.nodes, center);
    }
    const data = defaultsFor(type);
    if (type === 'trigger.schedule') data.timezone = localTimeZone(); // a new schedule starts on the clock of the person setting it up
    const node = { id: freshId(), type, position: { x: Math.round(pos.x), y: Math.round(pos.y) }, data, selected: true };
    edit.current.checkpoint();
    graphRef.current = { ...graphRef.current, nodes: [...graphRef.current.nodes.map((n) => ({ ...n, selected: false })), node] };
    setGraph(graphRef.current);
    markDirty();
  }, [rf, markDirty, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const duplicateNode = useCallback((id) => {
    const src = graphRef.current.nodes.find((n) => n.id === id);
    if (!src || graphRef.current.nodes.length >= LIMITS.nodesPerFlow) return;
    const copy = { ...structuredClone({ id: src.id, type: src.type, position: src.position, data: src.data }), id: freshId(), selected: true };
    copy.position = { x: src.position.x + 40, y: src.position.y + 40 };
    edit.current.checkpoint();
    graphRef.current = { ...graphRef.current, nodes: [...graphRef.current.nodes.map((n) => ({ ...n, selected: false })), copy] };
    setGraph(graphRef.current);
    markDirty();
  }, [markDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteNode = useCallback((id) => { rf.deleteElements({ nodes: [{ id }] }); }, [rf]);

  useEffect(() => { apiRef.current = { addNode }; return () => { apiRef.current = null; }; }, [apiRef, addNode]);

  const onDrop = (e) => {
    const type = e.dataTransfer.getData('application/flowbot-node');
    if (!type || !NODE_TYPES[type]) return;
    e.preventDefault();
    addNode(type, rf.screenToFlowPosition({ x: e.clientX - 90, y: e.clientY - 20 }));
  };

  // ---- saving, running, exporting ---------------------------------------------------------------
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await api(`/guilds/${gid}/flows/${flow.id}`, { method: 'PUT', body: { name: name.trim() || flow.name, graph: plain(graphRef.current) } });
      savedRef.current = snapFrom(nameRef.current, graphRef.current);
      setDirty(false);
      dirtyRef.current = false;
      onSaved(res.flow, res.sync);
      toast(res.sync && !res.sync.ok ? `Saved — but slash commands were not updated: ${res.sync.error}` : 'Saved — changes are live.', res.sync && !res.sync.ok ? 'error' : 'ok');
    } catch (e) {
      const detail = e.data?.issues?.map((i) => i.message).join(' ') ?? '';
      toast(`${e.message}${detail ? ` ${detail}` : ''}`, 'error');
    } finally { setSaving(false); }
  }, [gid, flow.id, flow.name, name, onSaved, toast, dirtyRef]);

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === 's') { e.preventDefault(); save(); return; }
      const typing = e.target instanceof Element && (e.target.closest('input, textarea, [contenteditable="true"]'));
      if (typing) return;
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); edit.current.undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); edit.current.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const runNode = useCallback(async (nodeId) => {
    try { await api(`/guilds/${gid}/flows/${flow.id}/run`, { method: 'POST', body: { nodeId } }); toast('Started — watch the Logs panel.', 'ok'); } catch (e) { toast(e.message, 'error'); }
  }, [gid, flow.id, toast]);

  const exportFlow = () => {
    const blob = new Blob([JSON.stringify({ format: 'flowbot-flow', version: 1, name, graph: plain(graphRef.current) }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w-]+/g, '_') || 'flow'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const nameOf = (n) => { const label = NODE_TYPES[n?.type]?.label ?? 'Node'; const title = nodeTitle(n?.data); return title ? `${title} (${label})` : label; };
  const focusNode = (id) => {
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, selected: n.id === id })) }));
    rf.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1, padding: 0.8 });
  };

  const selected = graph.nodes.find((n) => n.selected);
  const displayEdges = useMemo(() => graph.edges.map((e) => {
    const color = edgeColor(e.sourceHandle || 'out');
    return { ...e, type: 'smoothstep', style: { stroke: color, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color } };
  }), [graph.edges]);

  const ctx = useMemo(() => ({ gid, flowId: flow.id, dirty, feedMinMinutes: meta.feedMinMinutes, guildData, issuesByNode, flash, canRun: flow.enabled && !dirty, runNode }), [gid, flow.id, guildData, issuesByNode, flash, flow.enabled, dirty, meta.feedMinMinutes, runNode]);
  const listed = issues.filter((i) => i.level === 'error' || i.kind === 'graph');

  return (
    <EditorContext.Provider value={ctx}>
      <div className="workspace">
        <div className="canvas-col">
          <div className="flowbar">
            <input className="flow-name" aria-label="Flow name" value={name} maxLength={60} onChange={(e) => { edit.current.commitDrag(); if (!nameBaseline.current) nameBaseline.current = snapFrom(nameRef.current, graphRef.current); nameRef.current = e.target.value; setName(e.target.value); markDirty(); }} onBlur={() => edit.current.commitName()} />
            <label className="switch" title={flow.enabled ? 'This flow is live' : 'This flow is switched off'}>
              <input type="checkbox" checked={flow.enabled} onChange={(e) => onToggle(e.target.checked)} />
              <span className="track" /><span className="switch-label">{flow.enabled ? 'On' : 'Off'}</span>
            </label>
            <details className="issue-menu">
              <summary className={errorCount ? 'bad' : listed.length ? 'warn' : 'ok'}>
                {errorCount ? `${errorCount} to fix` : listed.length ? `${listed.length} notes` : '✓ No problems'}
              </summary>
              {listed.length > 0 && (
                <ul className="issue-pop">
                  {listed.map((i, k) => (
                    <li key={k}>
                      <button className="link" onClick={() => i.nodeId && focusNode(i.nodeId)}>
                        {i.nodeId ? `${nameOf(graph.nodes.find((n) => n.id === i.nodeId))}: ` : ''}{i.message}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <span className="spacer" />
            <button className="btn ghost small" disabled={!steps.undo} onClick={undo} title="Undo (Ctrl+Z)">Undo</button>
            <button className="btn ghost small" disabled={!steps.redo} onClick={redo} title="Redo (Ctrl+Shift+Z)">Redo</button>
            <button className="btn ghost small" onClick={exportFlow}>Export</button>
            <button className="btn primary" disabled={saving || !dirty} onClick={save} title="Ctrl+S">
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
          </div>
          <div className="canvas" ref={wrapRef} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={onDrop}>
            <ReactFlow
              nodes={graph.nodes} edges={displayEdges} nodeTypes={nodeTypes}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection}
              deleteKeyCode={['Backspace', 'Delete']} colorMode="dark"
              minZoom={0.2} maxZoom={1.6} proOptions={{ hideAttribution: true }} snapToGrid snapGrid={[10, 10]}
              connectionRadius={phone ? 44 : 28}
            >
              <Background gap={22} size={1.2} color="#3a3d44" />
              <Controls showInteractive={false} />
              {!phone && <MiniMap pannable zoomable nodeColor={(n) => `${{ trigger: '#f59e0b', message: '#5865f2', member: '#3ba55d', channel: '#14b8a6', role: '#ec4899', data: '#a855f7', logic: '#f97316' }[NODE_TYPES[n.type]?.category] ?? '#888'}`} maskColor="rgba(20,21,24,.7)" />}
            </ReactFlow>
            {graph.nodes.length === 0 && (
              <div className="canvas-empty">
                <h3>Start with a trigger</h3>
                <p>Open the <b>Nodes</b> tab and add <b>Slash Command</b> or an event such as <b>Member Joined</b>, then connect actions to it.</p>
                <button className="btn primary" onClick={() => addNode('trigger.command')}>Add a Slash Command</button>
              </div>
            )}
          </div>
        </div>
        {selected && (
          <Inspector
            node={selected} nodes={graph.nodes} edges={graph.edges} issues={issuesByNode[selected.id] || []}
            onChange={patchNode} onDuplicate={duplicateNode} onDelete={deleteNode}
            onClose={() => setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)) }))}
          />
        )}
      </div>
    </EditorContext.Provider>
  );
}
