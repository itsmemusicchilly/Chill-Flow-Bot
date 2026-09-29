import { LIMITS } from '../../../shared/limits.js';
import { evalConditions } from '../conditions.js';
import { FlowAbort, FlowError } from '../errors.js';
import { YIELD_EVERY, yieldToEventLoop } from '../yield.js';

const MAX_TIMER_MS = 2 ** 31 - 1; // larger delays overflow setTimeout and would fire immediately

/** Delay for a Wait node: never negative, never above the operator's cap, never above what a timer can hold. */
export function clampDelayMs(seconds) {
  return Math.min(Math.max(0, Number(seconds) * 1000), LIMITS.waitSeconds * 1000, MAX_TIMER_MS);
}

/** Sleep that ends early (without throwing) when the run is aborted, e.g. because the flow was switched off. */
function abortableSleep(ctx, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    ctx.abortController?.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function parseItems(s) {
  const t = String(s ?? '').trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x)));
    } catch { /* fall through to plain splitting */ }
  }
  return t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

export const logicExecutors = {
  async 'logic.condition'({ d }) { return evalConditions(d.match, d.conditions) ? 'true' : 'false'; },

  async 'logic.random'({ d }) {
    const chance = Math.min(100, Math.max(0, Number(d.chance)));
    if (!Number.isFinite(chance)) throw new FlowError('Chance must be a number between 0 and 100.');
    return Math.random() * 100 < chance ? 'true' : 'false';
  },

  async 'logic.loop'({ ctx, d, runBranch }) {
    // Iterated lazily: a huge repeat count must not allocate a huge array.
    let total;
    let itemAt;
    if (d.mode === 'repeat') {
      total = Math.trunc(Number(d.count));
      if (!Number.isFinite(total) || total < 1) throw new FlowError('The loop count must be at least 1.');
      itemAt = (i) => String(i + 1);
    } else {
      const items = parseItems(d.items);
      total = items.length;
      itemAt = (i) => items[i];
    }
    if (total > LIMITS.loopIterations) {
      ctx.services.logger.log(ctx.guild.id, 'warn', `Loop limited to ${LIMITS.loopIterations} iterations (had ${total}).`, ctx.logMeta);
      total = LIMITS.loopIterations;
    }
    const outer = ctx.loop;
    try {
      for (let i = 0; i < total; i += 1) {
        if (ctx.aborted) throw new FlowAbort('The flow was stopped.');
        if (i > 0 && i % YIELD_EVERY === 0) await yieldToEventLoop();
        ctx.loop = { index: i + 1, item: itemAt(i), count: total, first: i === 0, last: i === total - 1 };
        await runBranch('each');
      }
    } finally { ctx.loop = outer; }
    return 'done';
  },

  async 'logic.cooldown'({ ctx, d, node }) {
    const seconds = Number(d.seconds);
    if (!Number.isFinite(seconds) || seconds < 1) throw new FlowError('Cooldown seconds must be at least 1.');
    const who = d.scope === 'channel' ? ctx.channel?.id : d.scope === 'guild' ? ctx.guild.id : ctx.user?.id;
    const key = `${ctx.flow.id}|${d.key || node.id}|${d.scope}|${who ?? ''}`;
    const map = ctx.services.cooldowns;
    const now = Date.now();
    const until = map.get(key);
    if (until && until > now) { ctx.data.cooldown = { remaining: Math.ceil((until - now) / 1000) }; return 'blocked'; }
    if (map.size > 5000) for (const [k, v] of map) if (v <= now) map.delete(k);
    map.set(key, now + seconds * 1000);
    return 'ok';
  },

  async 'logic.wait'({ ctx, d }) {
    const s = Number(d.seconds);
    if (!Number.isFinite(s) || s < 0) throw new FlowError('Wait seconds must be 0 or more.');
    await abortableSleep(ctx, clampDelayMs(s));
    if (ctx.aborted) throw new FlowAbort('The flow was stopped.');
  },

  async 'logic.log'({ ctx, d }) {
    ctx.services.logger.log(ctx.guild.id, d.level === 'warn' ? 'warn' : 'info', String(d.message).slice(0, 500), ctx.logMeta);
  },
};
