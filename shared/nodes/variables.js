// Variables and maths: set and read the values flows remember, and calculate with them.
import { idField, num, select, text, when, whenNot } from '../fields.js';
import { ACTION_OUTS, def } from './core.js';

// ---- variables ----------------------------------------------------------------------------------
const VAR_NAME = { pattern: 'var' };
def('data.variable.set', {
  category: 'data', label: 'Set Variable', icon: '📦', description: 'Store or change a value. Server, channel and user variables are remembered between runs.',
  fields: [
    select('scope', 'Where to store it', [['run', 'This run only (temporary)'], ['guild', 'Server (remembered)'], ['channel', 'Channel (remembered)'], ['user', 'Per user (remembered)']]),
    idField('targetId', 'User', 'user', { showIf: when('scope', 'user'), placeholder: 'blank = the user who triggered this' }),
    idField('targetChannelId', 'Channel', 'channel', { showIf: when('scope', 'channel'), placeholder: 'blank = the channel where this happened' }),
    text('name', 'Variable name', { required: true, placeholder: 'coins', ...VAR_NAME }),
    select('operation', 'Operation', [['set', 'Set to'], ['add', 'Add'], ['subtract', 'Subtract'], ['multiply', 'Multiply by'], ['divide', 'Divide by'], ['append', 'Append to list'], ['expr', 'Calculate expression'], ['random', 'Random whole number'], ['delete', 'Delete']]),
    text('value', 'Value', { showIf: whenNot('operation', 'random', 'delete'), placeholder: 'e.g. 1 or {{option.name}}' }),
    select('valueType', 'Treat value as', [['text', 'Text'], ['number', 'Number'], ['boolean', 'True / False'], ['json', 'JSON']], { showIf: when('operation', 'set') }),
    num('min', 'Minimum', { showIf: when('operation', 'random'), default: 1 }),
    num('max', 'Maximum', { showIf: when('operation', 'random'), default: 6 }),
  ],
  outputs: ACTION_OUTS,
  summary: (d) => `${d.scope}.${d.name || '?'} ${d.operation}${d.value !== '' && d.value !== undefined && !['delete', 'random'].includes(d.operation) ? ` ${d.value}` : ''}`,
});
def('data.variable.get', {
  category: 'data', label: 'Get Variable', icon: '🔎', description: 'Read a remembered variable into this run as {{var.<name>}}.',
  fields: [
    select('scope', 'Read from', [['guild', 'Server'], ['channel', 'Channel'], ['user', 'Per user']]),
    idField('targetId', 'User', 'user', { showIf: when('scope', 'user'), placeholder: 'blank = the user who triggered this' }),
    idField('targetChannelId', 'Channel', 'channel', { showIf: when('scope', 'channel'), placeholder: 'blank = the channel where this happened' }),
    text('name', 'Variable name', { required: true, ...VAR_NAME }),
    text('saveAs', 'Save as', { required: true, placeholder: 'coins', ...VAR_NAME }),
    text('default', 'If missing use', { placeholder: '0' }),
  ],
  outputs: ACTION_OUTS, summary: (d) => `${d.scope}.${d.name || '?'} → ${d.saveAs || '?'}`,
});
// A leaderboard ranks everyone who holds a number in one per-user variable. Each line is written once and filled in per member, so its
// {{entry.*}} values are not ordinary variables: the executor reads the line as it was typed (see `render` in engine.js).
export const LEADERBOARD_LINE = '**{{entry.rank}}.** {{entry.mention}} — {{entry.value | commas}}';
export const LEADERBOARD_MAX = 25;
def('data.leaderboard', {
  category: 'data', label: 'Leaderboard', icon: '🏆',
  description: 'Rank members by a per-user variable — points, coins, XP. The top places are ready to post as {{leaderboard.text}}, and {{leaderboard.rank}} says where one member stands.',
  fields: [
    text('name', 'Per-user variable', { required: true, placeholder: 'points', help: 'The name you used in Set Variable or Math with “Per user”. Only numbers are ranked.', ...VAR_NAME }),
    num('limit', 'How many places', { default: 10, min: 1, max: LEADERBOARD_MAX }),
    select('order', 'Order', [['desc', 'Highest first'], ['asc', 'Lowest first']]),
    text('format', 'Each line', {
      default: LEADERBOARD_LINE,
      help: 'Written once, filled in for every place: {{entry.rank}}, {{entry.mention}}, {{entry.name}}, {{entry.id}} and {{entry.value}}. Filters work, for example {{entry.value | commas}}.',
    }),
    text('empty', 'If nobody has a value yet', { default: 'Nobody is on the board yet.' }),
    idField('targetId', 'Whose place to look up', 'user', {
      placeholder: 'blank = the user who triggered this',
      help: 'Their place and value are {{leaderboard.rank}} and {{leaderboard.value}} — both blank when they have none.',
    }),
  ],
  outputs: ACTION_OUTS,
  provides: () => [
    ['leaderboard.text', 'The top places, one per line'], ['leaderboard.count', 'How many places are listed'], ['leaderboard.total', 'How many members are ranked in all'],
    ['leaderboard.rank', 'The member’s place (blank if they have none)'], ['leaderboard.value', 'The member’s value (blank if they have none)'],
    ['leaderboard.top.id', 'ID of the member in first place'], ['leaderboard.top.mention', 'Mention of the member in first place'], ['leaderboard.top.value', 'Value of the member in first place'],
  ],
  summary: (d) => `top ${d.limit || 10} by ${d.name || '?'}`,
});
// Maths: Set Variable *changes a remembered number*; Math *calculates a new value from any values* (other variables, the member
// count, an option…) and hands it on as {{var.<name>}}, optionally remembering it as well.
const MATH_OPS = [['add', '+  Add'], ['sub', '−  Subtract'], ['mul', '×  Multiply'], ['div', '÷  Divide'], ['mod', 'Remainder after dividing'], ['pow', 'To the power of'], ['min', 'The smaller of the two'], ['max', 'The larger of the two']];
const MATH_SYMBOLS = { add: '+', sub: '−', mul: '×', div: '÷', mod: 'mod', pow: '^', min: 'min', max: 'max' };
def('data.math', {
  category: 'data', label: 'Math', icon: '🧮',
  description: 'Calculate a number from any values — variables, the member count, an option… — and use it in the next nodes as {{var.<name>}}. Tick “Also remember it” to keep it as a server, channel or per-user variable. To just change a remembered number, Set Variable is quicker.',
  fields: [
    select('mode', 'How', [['two', 'Two values'], ['formula', 'Formula']]),
    text('a', 'First value', { showIf: when('mode', 'two'), required: true, placeholder: '{{guild.vars.joins}}' }),
    select('op', 'Operation', MATH_OPS, { showIf: when('mode', 'two') }),
    text('b', 'Second value', { showIf: when('mode', 'two'), required: true, placeholder: '1' }),
    text('formula', 'Formula', {
      showIf: when('mode', 'formula'), required: true, placeholder: '({{var.a}} + {{var.b}}) * 2',
      help: 'Use + - * / % ^, brackets and round(), floor(), ceil(), abs(), sqrt(), min(), max(). An empty variable breaks a formula: write {{var.x | default:0}}.',
    }),
    select('round', 'Round the result', [['none', 'Do not round'], ['0', 'To a whole number'], ['1', 'To 1 decimal'], ['2', 'To 2 decimals']]),
    text('saveAs', 'Save result as', { required: true, placeholder: 'total', help: 'Use it in the next nodes as {{var.total}}.', ...VAR_NAME }),
    select('remember', 'Also remember it', [['none', 'No — only for this run'], ['guild', 'Yes, as a server variable'], ['channel', 'Yes, as a channel variable'], ['user', 'Yes, as a per-user variable']], { help: 'Remembered under the same name.' }),
    idField('targetId', 'User', 'user', { showIf: when('remember', 'user'), placeholder: 'blank = the user who triggered this' }),
    idField('targetChannelId', 'Channel', 'channel', { showIf: when('remember', 'channel'), placeholder: 'blank = the channel where this happened' }),
  ],
  outputs: ACTION_OUTS,
  summary: (d) => `${d.mode === 'formula' ? d.formula || '?' : `${d.a || '?'} ${MATH_SYMBOLS[d.op] ?? '?'} ${d.b || '?'}`} → ${d.saveAs || '?'}`,
});
