// Single source of truth for every node type. The editor renders its palette, cards and inspector from
// this file; the server uses it to validate graphs, compute handles and activate triggers.
import { defs, GUILD } from './nodes/core.js';
// Importing these adds their node definitions to the registry, in this order (the order of the palette and of docs/NODES.md).
import './nodes/triggers.js';
import './nodes/messages.js';
import './nodes/members.js';
import './nodes/channels.js';
import './nodes/roles.js';
import './nodes/variables.js';
import './nodes/logic.js';

export { BUTTON_ID_RE, buttonKey, CATEGORIES, CHANNEL_PERMISSIONS, COMMAND_PERMISSIONS, nodeTitle, ROLE_PERMISSIONS, TITLE_KEY, TITLE_MAX } from './nodes/core.js';
export { isVisible, VAR_NAME_RE } from './fields.js';

// ---------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------
export const NODE_TYPES = defs;
export const NODE_LIST = Object.values(defs);
export const isTriggerType = (type) => Boolean(defs[type]?.isTrigger);
export function getOutputs(type, data = {}) {
  const d = defs[type];
  if (!d) return [];
  return typeof d.outputs === 'function' ? d.outputs(data || {}) : d.outputs;
}
export function defaultsFor(type) {
  const d = defs[type];
  const out = {};
  for (const f of d?.fields || []) out[f.key] = structuredClone(f.default);
  return out;
}
/** Template variables a node can use, found by walking the graph backwards to its triggers. */
/** `extra.forms` (from GET /forms) lets a Form Submitted trigger list its own questions as {{form.<id>}}. */
export function availableVariables(nodes, edges, nodeId, extra = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map();
  for (const e of edges) { if (!incoming.has(e.target)) incoming.set(e.target, []); incoming.get(e.target).push(e); }
  const out = new Map();
  const add = (path, label) => { if (!out.has(path)) out.set(path, label); };
  for (const [p, l] of [...GUILD, ['now.iso', 'Current time (ISO)'], ['now.date', 'Current date'], ['now.time', 'Current time'], ['now.timestamp', 'Unix timestamp (s)']]) add(p, l);
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  let fromComponent = false;
  let fromError = false;
  while (queue.length) {
    const id = queue.shift();
    for (const e of incoming.get(id) || []) {
      const src = byId.get(e.source);
      if (!src) continue;
      const h = e.sourceHandle || 'out';
      if (h.startsWith('btn_') || h.startsWith('opt_') || src.type === 'trigger.button.clicked') fromComponent = true;
      if (h === 'error') fromError = true;
      if (seen.has(src.id)) continue;
      seen.add(src.id);
      queue.push(src.id);
      const d = defs[src.type];
      if (!d) continue;
      if (d.provides) for (const [p, l] of d.provides(src.data || {})) add(p, l);
      if (src.type === 'trigger.form.submitted') {
        for (const f of (extra.forms || []).find((x) => x.key === src.data?.form)?.fields || []) add(`form.${f.id}`, `Answer: ${f.label}`);
      }
      const sd = src.data || {};
      if (sd.outputVar) add(`var.${sd.outputVar}`, `Saved by “${d.label}”`);
      if (src.type === 'data.variable.set' && sd.scope === 'run' && sd.name) add(`var.${sd.name}`, 'Run variable');
      if (src.type === 'data.variable.get' && sd.saveAs) add(`var.${sd.saveAs}`, 'Loaded variable');
      if (src.type === 'data.math' && sd.saveAs) add(`var.${sd.saveAs}`, 'Math result');
      if (src.type === 'action.message.send' && sd.menuEnabled) { add('select.value', 'Selected menu option'); }
    }
  }
  add('user.vars.<name>', 'Remembered per-user variable');
  add('channel.vars.<name>', 'Remembered channel variable');
  add('guild.vars.<name>', 'Remembered server variable');
  if (fromComponent) {
    for (const [p, l] of [['original.user.name', 'Original user name'], ['original.user.id', 'Original user ID'], ['original.user.mention', 'Original user mention'], ['original.channel.id', 'Original channel ID'], ['original.option.<name>', 'Original command option']]) add(p, l);
  }
  if (fromError) { add('error.message', 'Error message'); }
  return [...out].map(([path, label]) => ({ path, label }));
}
