// Walks a flow graph. Each node is rendered (templates), executed, and then its chosen output handle(s)
// are followed. A failing node follows its "error" output if connected, otherwise ends that branch.
import { NODE_TYPES } from '../../shared/catalog.js';
import { isCapped, LIMITS } from '../../shared/limits.js';
import { FlowAbort, friendlyError } from './errors.js';
import { executors } from './executors/index.js';
import { takeAction } from './resolve.js';
import { nowInfo } from './serialize.js';
import { renderDeep } from './template.js';
import { YIELD_EVERY, yieldToEventLoop } from './yield.js';

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

// A physical ceiling (not a policy limit): entries waiting on the traversal stack. Only a graph that fans out AND loops
// back on itself can reach it; without it such a graph would eventually exhaust the whole process's memory.
export const CEILINGS = { pendingBranches: 1_000_000 };
const DEBUG_LOG_FIRST = 200;
const DEBUG_LOG_EVERY = 500;

/**
 * Depth-first walk from `handle` of `nodeId`, using an explicit stack instead of recursion: the order is the same as
 * before (an output's targets run one after another, each fully before the next), but a graph that loops back on itself
 * runs in constant memory instead of nesting promises forever.
 */
async function runBranch(flow, ctx, nodeId, handle) {
  const { out } = compileFlow(flow);
  const stack = [];
  const pushSuccessors = (fromId, handles) => {
    for (let i = handles.length - 1; i >= 0; i -= 1) {
      const edges = out.get(`${fromId}|${handles[i]}`);
      if (edges) for (let j = edges.length - 1; j >= 0; j -= 1) stack.push(edges[j].target);
    }
    if (stack.length > CEILINGS.pendingBranches) throw new FlowAbort('Too many branches are waiting to run at once — check for a loop that fans out.');
  };
  pushSuccessors(nodeId, [handle]);
  while (stack.length) {
    if (ctx.aborted) throw new FlowAbort('The flow was stopped.');
    const id = stack.pop();
    pushSuccessors(id, await execNode(flow, ctx, id));
  }
}

/** Runs one node and returns the output handle(s) to follow next ([] when the branch ends). */
async function execNode(flow, ctx, nodeId) {
  const { byId, out } = compileFlow(flow);
  const node = byId.get(nodeId);
  if (!node) return [];
  ctx.steps += 1;
  if (isCapped(LIMITS.stepsPerRun) && ctx.steps > LIMITS.stepsPerRun) throw new FlowAbort(`Stopped after ${LIMITS.stepsPerRun} steps — is there an endless loop?`);
  if (ctx.steps % YIELD_EVERY === 0) await yieldToEventLoop();

  const def = NODE_TYPES[node.type];
  const exec = executors[node.type];
  const gid = ctx.guild.id;
  ctx.logMeta = { flowId: flow.id, flowName: flow.name, runId: ctx.runId, nodeId: node.id };
  if (!def || !exec) {
    ctx.services.logger.log(gid, 'warn', `Skipped unknown node type “${node.type}”.`, ctx.logMeta);
    return [];
  }
  if (ctx.steps <= DEBUG_LOG_FIRST || ctx.steps % DEBUG_LOG_EVERY === 0) {
    ctx.services.logger.log(gid, 'debug', `▸ ${def.label}${ctx.steps === DEBUG_LOG_FIRST ? ' (further steps are logged sparsely)' : ''}`, ctx.logMeta);
  }

  try {
    const d = renderDeep(node.data, buildScope(ctx));
    if (node.type.startsWith('action.')) takeAction(ctx);
    const result = await exec({ ctx, d, node, flow, runBranch: (h) => runBranch(flow, ctx, nodeId, h) });
    if (result === undefined) return ['out'];
    return Array.isArray(result) ? result : [result];
  } catch (err) {
    if (err instanceof FlowAbort) throw err;
    const message = friendlyError(err);
    ctx.services.logger.log(gid, 'error', `${def.label}: ${message}`, ctx.logMeta);
    if (out.has(`${nodeId}|error`)) {
      ctx.error = { message, node: node.id };
      return ['error'];
    }
    ctx.failed = true;
    return [];
  }
}

/** Run everything reachable from `handle` of `startNodeId` (a trigger, or a message node for a button click). */
export async function runFlow(flow, startNodeId, handle, ctx) {
  await runBranch(flow, ctx, startNodeId, handle);
}
