import { LIMITS } from '../../../shared/limits.js';
import { evalConditions } from '../conditions.js';
import { FlowAbort, FlowError } from '../errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    let items;
    if (d.mode === 'repeat') {
      const n = Math.trunc(Number(d.count));
      if (!Number.isFinite(n) || n < 1) throw new FlowError('The loop count must be at least 1.');
      items = Array.from({ length: n }, (_, i) => String(i + 1));
    } else {
      items = parseItems(d.items);
    }
    if (items.length > LIMITS.loopIterations) {
      ctx.services.logger.log(ctx.guild.id, 'warn', `Loop limited to ${LIMITS.loopIterations} iterations (had ${items.length}).`, ctx.logMeta);
      items = items.slice(0, LIMITS.loopIterations);
    }
    const outer = ctx.loop;
    try {
      for (let i = 0; i < items.length; i += 1) {
        if (ctx.aborted) throw new FlowAbort('The flow was stopped.');
        ctx.loop = { index: i + 1, item: items[i], count: items.length, first: i === 0, last: i === items.length - 1 };
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
    await sleep(Math.min(s, LIMITS.waitSeconds) * 1000);
    if (ctx.aborted) throw new FlowAbort('The flow was stopped.');
  },

  async 'logic.log'({ ctx, d }) {
    ctx.services.logger.log(ctx.guild.id, d.level === 'warn' ? 'warn' : 'info', String(d.message).slice(0, 500), ctx.logMeta);
  },
};
