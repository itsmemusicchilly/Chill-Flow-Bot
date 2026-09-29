import { FlowError } from '../errors.js';
import { evaluate } from '../expression.js';
import { cleanId, SNOWFLAKE } from '../resolve.js';

const toNumber = (v, fallback) => {
  if (v === undefined || v === null || v === '') { if (fallback !== undefined) return fallback; throw new FlowError('A number is needed here but the value is empty.'); }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new FlowError(`“${String(v).slice(0, 40)}” is not a number.`);
  return n;
};

function scopeTarget(ctx, d) {
  if (d.scope === 'guild') return { scope: 'guild', id: '' };
  if (d.scope === 'user') {
    const id = cleanId(d.targetId) || ctx.user?.id;
    if (!id || !SNOWFLAKE.test(id)) throw new FlowError('No user for this per-user variable — fill in the User field.');
    return { scope: 'user', id };
  }
  return { scope: 'run', id: '' };
}

const castSet = (value, type) => {
  switch (type) {
    case 'number': return toNumber(value);
    case 'boolean': return /^(true|yes|1|on)$/i.test(String(value).trim());
    case 'json': try { return JSON.parse(value); } catch { throw new FlowError('The value is not valid JSON.'); }
    default: return String(value ?? '');
  }
};

export const dataExecutors = {
  async 'data.variable.set'({ ctx, d }) {
    const { scope, id } = scopeTarget(ctx, d);
    const gid = ctx.guild.id;
    const read = () => (scope === 'run' ? ctx.vars[d.name] : ctx.services.db.getVar(gid, scope, id, d.name));
    const write = (v) => { if (scope === 'run') ctx.vars[d.name] = v; else ctx.services.db.setVar(gid, scope, id, d.name, v); };
    const arith = (fn) => write(fn(toNumber(read(), 0), toNumber(d.value)));

    switch (d.operation) {
      case 'set': write(castSet(d.value, d.valueType)); break;
      case 'add': arith((a, b) => a + b); break;
      case 'subtract': arith((a, b) => a - b); break;
      case 'multiply': arith((a, b) => a * b); break;
      case 'divide': arith((a, b) => { if (b === 0) throw new FlowError('Cannot divide by zero.'); return a / b; }); break;
      case 'append': {
        const cur = read();
        const arr = Array.isArray(cur) ? [...cur] : cur === undefined ? [] : [cur];
        arr.push(String(d.value ?? ''));
        write(arr.slice(-200));
        break;
      }
      case 'expr': try { write(evaluate(d.value)); } catch (e) { throw new FlowError(e.message); } break;
      case 'random': {
        let lo = Math.trunc(toNumber(d.min, 1)); let hi = Math.trunc(toNumber(d.max, 6));
        if (lo > hi) [lo, hi] = [hi, lo];
        write(lo + Math.floor(Math.random() * (hi - lo + 1)));
        break;
      }
      case 'delete': if (scope === 'run') delete ctx.vars[d.name]; else ctx.services.db.deleteVar(gid, scope, id, d.name); break;
      default: throw new FlowError(`Unknown operation “${d.operation}”.`);
    }
  },

  async 'data.variable.get'({ ctx, d }) {
    const { scope, id } = scopeTarget(ctx, d);
    const v = ctx.services.db.getVar(ctx.guild.id, scope, id, d.name);
    ctx.vars[d.saveAs] = v === undefined ? d.default : v;
  },
};
