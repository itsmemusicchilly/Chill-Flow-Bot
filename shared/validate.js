// Graph normalisation + validation, shared by the editor (live warnings) and the server (authoritative).
import { NODE_TYPES, TITLE_KEY, getOutputs, isTriggerType, nodeTitle } from './catalog.js';
import { connectionKey } from './connections.js';
import { upgradeNodeData } from './upgrade.js';
import { checkFields } from './fields.js';
import { isCapped, LIMITS } from './limits.js';
import { CONNECTIONS, INTEGRATIONS } from './platforms.js';

export const ID_RE = /^[A-Za-z0-9_-]{1,12}$/;

/** The node's title, tidied (one line, at most TITLE_MAX characters); an empty or missing title is not stored at all. */
function withCleanTitle(data) {
  if (!(TITLE_KEY in data)) return data;
  const { [TITLE_KEY]: _old, ...rest } = data;
  const title = nodeTitle(data);
  return title ? { ...rest, [TITLE_KEY]: title } : rest;
}

/** Keep only the keys we persist (React Flow adds `selected`, `measured`, … at runtime). */
export function normalizeGraph(input) {
  const nodes = (Array.isArray(input?.nodes) ? input.nodes : []).map((n) => ({
    id: String(n?.id ?? ''),
    type: String(n?.type ?? ''),
    position: { x: Math.round(Number(n?.position?.x) || 0), y: Math.round(Number(n?.position?.y) || 0) },
    data: withCleanTitle(upgradeNodeData(String(n?.type ?? ''), n?.data && typeof n.data === 'object' && !Array.isArray(n.data) ? n.data : {})),
  }));
  const edges = (Array.isArray(input?.edges) ? input.edges : []).map((e) => {
    const sourceHandle = e?.sourceHandle || 'out';
    return {
      id: String(e?.id || `${e?.source}:${sourceHandle}>${e?.target}`),
      source: String(e?.source ?? ''),
      sourceHandle,
      target: String(e?.target ?? ''),
      targetHandle: 'in',
    };
  });
  return { nodes, edges };
}

/**
 * @returns {{nodeId: string|null, level: 'error'|'warning', kind: 'structure'|'config'|'intent'|'graph', message: string}[]}
 * `kind: 'structure'` issues make a graph unsavable; the rest are shown as warnings but can be saved.
 * `accounts` (optional) = which creator accounts this server has connected, e.g. `{ twitch: true }`; without it that check is skipped.
 */
export function validateFlow(graph, { intents, integrations, accounts } = {}) {
  const issues = [];
  const add = (nodeId, level, kind, message) => issues.push({ nodeId, level, kind, message });
  const { nodes, edges } = graph;

  if (nodes.length > LIMITS.nodesPerFlow) add(null, 'error', 'structure', `A flow can have at most ${LIMITS.nodesPerFlow} nodes.`);
  if (edges.length > LIMITS.edgesPerFlow) add(null, 'error', 'structure', `A flow can have at most ${LIMITS.edgesPerFlow} connections.`);

  const byId = new Map();
  for (const n of nodes) {
    if (!ID_RE.test(n.id)) { add(null, 'error', 'structure', `Invalid node id “${n.id}”.`); continue; }
    if (byId.has(n.id)) { add(n.id, 'error', 'structure', `Duplicate node id “${n.id}”.`); continue; }
    byId.set(n.id, n);
    if (!NODE_TYPES[n.type]) { add(n.id, 'error', 'structure', `Unknown node type “${n.type}”.`); continue; }
    if (isCapped(LIMITS.nodeDataBytes) && JSON.stringify(n.data).length > LIMITS.nodeDataBytes) add(n.id, 'error', 'structure', 'This node holds too much data.');
  }

  const edgeKeys = new Set();
  for (const e of edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) { add(null, 'error', 'structure', 'A connection points to a node that does not exist.'); continue; }
    if (e.source === e.target) { add(e.source, 'error', 'structure', 'A node cannot connect to itself.'); continue; }
    if (!NODE_TYPES[src.type] || !NODE_TYPES[dst.type]) continue;
    if (isTriggerType(dst.type)) { add(dst.id, 'error', 'structure', 'Triggers start a flow — nothing can connect into them.'); continue; }
    if (!getOutputs(src.type, src.data).some((o) => o.id === e.sourceHandle)) {
      add(src.id, 'error', 'structure', `A connection leaves an output (“${e.sourceHandle}”) that no longer exists.`);
      continue;
    }
    const key = connectionKey(e);
    if (edgeKeys.has(key)) add(src.id, 'error', 'structure', 'Duplicate connection.');
    edgeKeys.add(key);
  }

  const reachable = new Set();
  const stack = nodes.filter((n) => isTriggerType(n.type)).map((n) => n.id);
  stack.forEach((id) => reachable.add(id));
  while (stack.length) {
    const id = stack.pop();
    for (const e of edges) if (e.source === id && byId.has(e.target) && !reachable.has(e.target)) { reachable.add(e.target); stack.push(e.target); }
  }

  const triggers = nodes.filter((n) => isTriggerType(n.type));
  if (!triggers.length) add(null, 'warning', 'graph', 'Add a trigger (a command or event) so this flow has something to start it.');

  for (const n of byId.values()) {
    const d = NODE_TYPES[n.type];
    if (!d) continue;
    const push = (m) => add(n.id, 'error', 'config', m);
    checkFields(d.fields, n.data, '', push);
    for (const m of d.check?.(n.data) || []) push(m);
    if (d.requires && intents && !intents[d.requires]) {
      add(n.id, 'error', 'intent', `This trigger needs the ${d.requires === 'members' ? 'Server Members' : 'Message Content'} intent, which the bot operator has not enabled — it will not run.`);
    }
    // `needs` = something the bot operator must have set up (an API key); without it the trigger cannot work.
    if (d.needs && integrations && !integrations[d.needs]) {
      add(n.id, 'error', 'intent', `This trigger needs ${INTEGRATIONS[d.needs]}, which the bot operator has not set up — it will not run.`);
    }
    // `connect` = a creator account that someone must connect to this server (Accounts); `accounts` says which ones are (see accountFlagsFrom).
    // A trigger may name one of several accounts (`data.account`); blank = the first one that works.
    // Not said when the operator's app is missing too: that message already explains why nothing will run.
    if (d.connect && accounts && !(d.needs && integrations && !integrations[d.needs])) {
      const wanted = String(n.data?.account ?? '').trim();
      const label = CONNECTIONS[d.connect];
      if (wanted && accounts.ids?.[d.connect]) {
        if (!accounts.ids[d.connect].includes(wanted)) add(n.id, 'error', 'intent', `The ${label} account chosen here is not connected any more (or must be connected again): open “Accounts” in the top bar — it will not run until then.`);
      } else if (!accounts[d.connect]) {
        add(n.id, 'error', 'intent', `Connect a ${label} account first: open “Accounts” in the top bar and press Connect ${label} — it will not run until then.`);
      }
    }
    // `wants` = works better with an intent but does not need it: warn, never block.
    if (d.wants && intents && !intents[d.wants]) {
      add(n.id, 'warning', 'intent', d.wantsNote || `This works better with the ${d.wants === 'members' ? 'Server Members' : 'Message Content'} intent, which the bot operator has not enabled.`);
    }
    if (d.isTrigger) {
      if (!edges.some((e) => e.source === n.id)) add(n.id, 'warning', 'graph', 'Connect this trigger to something to do.');
    } else if (!reachable.has(n.id)) {
      add(n.id, 'warning', 'graph', 'Not connected to a trigger, so it will never run.');
    }
  }

  // A button press can only be answered once, so every Button ID needs exactly one handler.
  const handlers = new Map();
  for (const n of nodes) {
    if (n.type !== 'trigger.button.clicked') continue;
    const id = String(n.data?.customId ?? '').trim();
    if (!id) continue;
    if (handlers.has(id)) add(n.id, 'warning', 'graph', `Button ID “${id}” is already handled by another trigger in this flow — only the first one runs.`);
    else handlers.set(id, n.id);
  }
  return issues;
}

export const hasStructureErrors = (issues) => issues.some((i) => i.kind === 'structure');
