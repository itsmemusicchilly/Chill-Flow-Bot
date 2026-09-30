import {
  applyEdgeChanges, applyNodeChanges, Background, Controls, MarkerType, MiniMap, ReactFlow, useNodesInitialized, useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultsFor, getOutputs, isTriggerType, NODE_TYPES } from '@shared/catalog.js';
import { localTimeZone } from '@shared/cron.js';
import { toggleConnection } from '@shared/connections.js';
import { LIMITS } from '@shared/limits.js';
import { uid } from '@shared/util.js';
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

export default function FlowWorkspace({ gid, flow, meta, guildData, flash, apiRef, dirtyRef, onSaved, onToggle }) {
  const toast = useToast();
  const rf = useReactFlow();
  const wrapRef = useRef(null);
  const [graph, setGraph] = useState(() => ({ nodes: flow.graph.nodes.map((n) => ({ ...n })), edges: flow.graph.edges.map((e) => ({ ...e })) }));
  const [name, setName] = useState(flow.name);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Fit the whole flow into view once every node has been measured (the `fitView` prop can fire too early).
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (initialized && !fitted.current) { fitted.current = true; rf.fitView({ maxZoom: 0.9, padding: 0.25 }); }
  }, [initialized, rf]);

  const markDirty = useCallback(() => { setDirty(true); dirtyRef.current = true; }, [dirtyRef]);
  useEffect(() => { dirtyRef.current = false; return () => { dirtyRef.current = false; }; }, [dirtyRef]);
  useEffect(() => {
    const warn = (e) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyRef]);

  // ---- validation (same rules as the server) ---------------------------------------------------
  const issues = useMemo(() => validateFlow(normalizeGraph(graph), { intents: meta.intents }), [graph, meta.intents]);
  const issuesByNode = useMemo(() => {
    const map = {};
    for (const i of issues) if (i.nodeId) (map[i.nodeId] ||= []).push(i);
    return map;
  }, [issues]);
  const errorCount = issues.filter((i) => i.level === 'error').length;

  // ---- graph editing ---------------------------------------------------------------------------
  const onNodesChange = useCallback((changes) => {
    setGraph((g) => ({ ...g, nodes: applyNodeChanges(changes, g.nodes) }));
    if (changes.some((c) => ['position', 'remove', 'add', 'replace'].includes(c.type))) markDirty();
  }, [markDirty]);
  const onEdgesChange = useCallback((changes) => {
    setGraph((g) => ({ ...g, edges: applyEdgeChanges(changes, g.edges) }));
    if (changes.some((c) => ['remove', 'add', 'replace'].includes(c.type))) markDirty();
  }, [markDirty]);
  // Dragging a connection between two things that are already connected removes it: connecting twice undoes the first.
  const onConnect = useCallback((c) => {
    const { edges, removed } = toggleConnection(graphRef.current.edges, c);
    setGraph((g) => ({ ...g, edges }));
    markDirty();
    if (removed) toast('Connection removed.', 'info');
  }, [markDirty, toast]);
  const isValidConnection = useCallback((c) => {
    const target = graphRef.current.nodes.find((n) => n.id === c.target);
    return c.source !== c.target && Boolean(target) && !isTriggerType(target.type);
  }, []);

  const patchNode = useCallback((id, patch) => {
    setGraph((g) => {
      const nodes = g.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
      const target = nodes.find((n) => n.id === id);
      const valid = new Set(getOutputs(target.type, target.data).map((o) => o.id));
      // a removed button/option must not leave a dangling connection behind
      return { nodes, edges: g.edges.filter((e) => e.source !== id || valid.has(e.sourceHandle || 'out')) };
    });
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
    setGraph((g) => ({ ...g, nodes: [...g.nodes.map((n) => ({ ...n, selected: false })), node] }));
    markDirty();
  }, [rf, markDirty, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const duplicateNode = useCallback((id) => {
    const src = graphRef.current.nodes.find((n) => n.id === id);
    if (!src || graphRef.current.nodes.length >= LIMITS.nodesPerFlow) return;
    const copy = { ...structuredClone({ id: src.id, type: src.type, position: src.position, data: src.data }), id: freshId(), selected: true };
    copy.position = { x: src.position.x + 40, y: src.position.y + 40 };
    setGraph((g) => ({ ...g, nodes: [...g.nodes.map((n) => ({ ...n, selected: false })), copy] }));
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
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
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

  const focusNode = (id) => {
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, selected: n.id === id })) }));
    rf.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1, padding: 0.8 });
  };

  const selected = graph.nodes.find((n) => n.selected);
  const displayEdges = useMemo(() => graph.edges.map((e) => {
    const color = edgeColor(e.sourceHandle || 'out');
    return { ...e, type: 'smoothstep', style: { stroke: color, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color } };
  }), [graph.edges]);

  const ctx = useMemo(() => ({ guildData, issuesByNode, flash, canRun: flow.enabled && !dirty, runNode }), [guildData, issuesByNode, flash, flow.enabled, dirty, runNode]);
  const listed = issues.filter((i) => i.level === 'error' || i.kind === 'graph');

  return (
    <EditorContext.Provider value={ctx}>
      <div className="workspace">
        <div className="canvas-col">
          <div className="flowbar">
            <input className="flow-name" aria-label="Flow name" value={name} maxLength={60} onChange={(e) => { setName(e.target.value); markDirty(); }} />
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
                        {i.nodeId ? `${NODE_TYPES[graph.nodes.find((n) => n.id === i.nodeId)?.type]?.label ?? 'Node'}: ` : ''}{i.message}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <span className="spacer" />
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
              connectionRadius={28}
            >
              <Background gap={22} size={1.2} color="#3a3d44" />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(n) => `${{ trigger: '#f59e0b', message: '#5865f2', member: '#3ba55d', channel: '#14b8a6', role: '#ec4899', data: '#a855f7', logic: '#f97316' }[NODE_TYPES[n.type]?.category] ?? '#888'}`} maskColor="rgba(20,21,24,.7)" />
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
          />
        )}
      </div>
    </EditorContext.Provider>
  );
}
