// Walks a flow graph. Each node is rendered (templates), executed, and then its chosen output handle(s)
// are followed. A failing node follows its "error" output if connected, otherwise ends that branch.
import { NODE_TYPES } from '../../shared/catalog.js';
import { LIMITS } from '../../shared/limits.js';
import { FlowAbort, friendlyError } from './errors.js';
import { executors } from './executors/index.js';
import { takeAction } from './resolve.js';
import { nowInfo } from './serialize.js';
import { renderDeep } from './template.js';

const compiled = new WeakMap();

/** Index a flow's edges once. Fan-out from one output runs top-to-bottom, then left-to-right. */
export function compileFlow(flow) {
  let c = compiled.get(flow);
  if (c) return c;
  const byId = new Map(flow.graph.nodes.map((n) => [n.id, n]));
  const out = new Map();
  for (const e of flow.graph.edges) {
    const key = `${e.source}|${e.sourceHandle || 'out'}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(e);
  }
  for (const list of out.values()) {
    list.sort((a, b) => {
      const A = byId.get(a.target)?.position || { x: 0, y: 0 };
      const B = byId.get(b.target)?.position || { x: 0, y: 0 };
      return A.y - B.y || A.x - B.x;
    });
  }
  c = { byId, out };
  compiled.set(flow, c);
  return c;
}

function lazyProp(obj, key, fn) {
  let cache;
  let done = false;
  Object.defineProperty(obj, key, { enumerable: true, configurable: true, get() { if (!done) { cache = fn(); done = true; } return cache; } });
  return obj;
}

/** The data templates can see: {{user.*}} {{var.*}} {{guild.vars.*}} {{loop.*}} … */
export function buildScope(ctx) {
  const { db } = ctx.services;
  const gid = ctx.guild.id;
  const scope = { ...ctx.data, var: ctx.vars, loop: ctx.loop ?? undefined, error: ctx.error ?? undefined, now: nowInfo() };
  scope.guild = lazyProp({ ...(ctx.data.guild || {}) }, 'vars', () => db.varsFor(gid, 'guild', ''));
  if (ctx.data.user) {
    scope.user = lazyProp({ ...ctx.data.user }, 'vars', () => db.varsFor(gid, 'user', ctx.data.user.id));
  }
  return scope;
}

async function runBranch(flow, ctx, nodeId, handle) {
  const edges = compileFlow(flow).out.get(`${nodeId}|${handle}`);
  if (!edges) return;
  for (const e of edges) await runNode(flow, ctx, e.target);
}

async function runNode(flow, ctx, nodeId) {
  const { byId, out } = compileFlow(flow);
  const node = byId.get(nodeId);
  if (!node) return;
  if (ctx.aborted) throw new FlowAbort('The flow was stopped.');
  ctx.steps += 1;
  if (ctx.steps > LIMITS.stepsPerRun) throw new FlowAbort(`Stopped after ${LIMITS.stepsPerRun} steps — is there an endless loop?`);

  const def = NODE_TYPES[node.type];
  const exec = executors[node.type];
  const gid = ctx.guild.id;
  ctx.logMeta = { flowId: flow.id, flowName: flow.name, runId: ctx.runId, nodeId: node.id };
  if (!def || !exec) {
    ctx.services.logger.log(gid, 'warn', `Skipped unknown node type “${node.type}”.`, ctx.logMeta);
    return;
  }
  ctx.services.logger.log(gid, 'debug', `▸ ${def.label}`, ctx.logMeta);

  let handles = ['out'];
  try {
    const d = renderDeep(node.data, buildScope(ctx));
    if (node.type.startsWith('action.')) takeAction(ctx);
    const result = await exec({ ctx, d, node, flow, runBranch: (h) => runBranch(flow, ctx, nodeId, h) });
    if (result !== undefined) handles = Array.isArray(result) ? result : [result];
  } catch (err) {
    if (err instanceof FlowAbort) throw err;
    const message = friendlyError(err);
    ctx.services.logger.log(gid, 'error', `${def.label}: ${message}`, ctx.logMeta);
    if (out.has(`${nodeId}|error`)) {
      ctx.error = { message, node: node.id };
      handles = ['error'];
    } else {
      ctx.failed = true;
      return;
    }
  }
  for (const h of handles) await runBranch(flow, ctx, nodeId, h);
}

/** Run everything reachable from `handle` of `startNodeId` (a trigger, or a message node for a button click). */
export async function runFlow(flow, startNodeId, handle, ctx) {
  await runBranch(flow, ctx, startNodeId, handle);
}
