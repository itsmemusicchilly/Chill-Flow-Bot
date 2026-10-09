// Logic: conditions, random choice, loops, cooldowns, waiting and writing to the log.
import { area, idField, list, num, select, text, when, whenNot } from '../fields.js';
import { def, OUT } from './core.js';

// ---- logic --------------------------------------------------------------------------------------
const ROLE_OPS = ['hasRole', 'lacksRole'];
const COND_OPS = [['equals', 'equals'], ['notEquals', 'does not equal'], ['contains', 'contains'], ['notContains', 'does not contain'], ['startsWith', 'starts with'], ['endsWith', 'ends with'], ['gt', 'is greater than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most'], ['matches', 'matches regex'], ['isEmpty', 'is empty'], ['isNotEmpty', 'is not empty'], ['hasRole', 'has the role'], ['lacksRole', 'does not have the role']];
/** One check as words. `names.role(id)` (when the editor can supply it) turns a role id into its name. */
const conditionText = (c, names) => {
  if (ROLE_OPS.includes(c.op)) return `${c.op === 'hasRole' ? 'has' : 'lacks'} role ${(names?.role?.(c.roleId) ?? c.roleId) || '?'}${c.memberId ? ` (${c.memberId})` : ''}`;
  return `${c.left} ${c.op} ${c.right ?? ''}`;
};
def('logic.condition', {
  category: 'logic', label: 'Condition (If)', icon: '🔀', description: 'Follow the True or False output depending on your checks — compare values, or check whether someone has a role.',
  fields: [
    select('match', 'Continue on True when', [['all', 'ALL checks pass'], ['any', 'ANY check passes']]),
    list('conditions', 'Checks', {
      create: () => ({ left: '{{user.name}}', op: 'equals', right: '', roleId: '', memberId: '' }),
      label: (c, names) => conditionText(c, names),
      fields: [
        text('left', 'Value', { required: true, placeholder: '{{option.amount}}', showIf: whenNot('op', ...ROLE_OPS) }),
        select('op', 'Check', COND_OPS),
        text('right', 'Compare to', { showIf: whenNot('op', 'isEmpty', 'isNotEmpty', ...ROLE_OPS) }),
        idField('roleId', 'Role', 'role', {
          required: true, showIf: when('op', ...ROLE_OPS),
          help: 'Pick a role, or use a variable such as {{option.role}}. If the role no longer exists, the check counts as “no”.',
        }),
        idField('memberId', 'Member', 'user', {
          showIf: when('op', ...ROLE_OPS), placeholder: 'blank = whoever triggered this',
          help: 'Optional: check someone else, for example {{option.member}}. Someone who is not in the server does not have the role.',
        }),
      ],
    }),
  ],
  outputs: [{ id: 'true', label: 'True', kind: 'true' }, { id: 'false', label: 'False', kind: 'false' }],
  summary: (d, names) => (d.conditions || []).map((c) => conditionText(c, names)).join(d.match === 'any' ? ' OR ' : ' AND ').slice(0, 60),
  check: (d) => ((d.conditions || []).length ? [] : ['Add at least one check.']),
});
def('logic.random', {
  category: 'logic', label: 'Random Chance', icon: '🎲', description: 'Follow True with the given probability, otherwise False.',
  fields: [num('chance', 'Chance of True (%)', { default: 50, min: 0, max: 100, required: true })],
  outputs: [{ id: 'true', label: 'True', kind: 'true' }, { id: 'false', label: 'False', kind: 'false' }], summary: (d) => `${d.chance}%`,
});
def('logic.loop', {
  category: 'logic', label: 'Loop', icon: '🔁', description: 'Run the “Each” branch several times, then continue with “Done”. Uses {{loop.index}} and {{loop.item}}.',
  fields: [
    select('mode', 'Loop', [['repeat', 'A number of times'], ['list', 'Over a list']]),
    num('count', 'Times', { showIf: when('mode', 'repeat'), default: 3, min: 1 }),
    area('items', 'List', { showIf: when('mode', 'list'), placeholder: 'One per line, comma-separated, or a JSON array', rows: 3 }),
  ],
  outputs: [{ id: 'each', label: 'Each', kind: 'branch' }, { id: 'done', label: 'Done' }],
  provides: () => [['loop.index', 'Loop index (from 1)'], ['loop.item', 'Current item'], ['loop.count', 'Total iterations']],
  summary: (d) => (d.mode === 'repeat' ? `${d.count}×` : 'over list'),
});
def('logic.cooldown', {
  category: 'logic', label: 'Cooldown', icon: '🧊', description: 'Let a flow run only once per time window. Blocked runs follow the Blocked output.',
  fields: [
    num('seconds', 'Seconds', { default: 30, min: 1, required: true }),
    select('scope', 'Per', [['user', 'User'], ['channel', 'Channel'], ['guild', 'Server']]),
    text('key', 'Shared name (optional)', { help: 'Nodes with the same name share one cooldown.' }),
  ],
  outputs: [{ id: 'ok', label: 'Allowed', kind: 'true' }, { id: 'blocked', label: 'Blocked', kind: 'false' }],
  provides: () => [['cooldown.remaining', 'Seconds left (when blocked)']], summary: (d) => `${d.seconds}s per ${d.scope}`,
});
def('logic.wait', {
  category: 'logic', label: 'Wait', icon: '⌛', description: 'Pause the flow for a while. Switching the flow off stops it.',
  fields: [num('seconds', 'Seconds', { default: 5, min: 0, required: true })], outputs: [OUT], summary: (d) => `${d.seconds}s`,
});
def('logic.log', {
  category: 'logic', label: 'Log', icon: '📋', description: 'Write a line to the Logs panel — handy for debugging.',
  fields: [select('level', 'Level', [['info', 'Info'], ['warn', 'Warning']]), area('message', 'Message', { required: true, rows: 2 })],
  outputs: [OUT], summary: (d) => (d.message || '').slice(0, 40),
});
