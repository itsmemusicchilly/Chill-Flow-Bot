// Connect: run the steps of another flow, and (when the bot operator has switched it on) ask a website for something.
import { area, bool, idField, list, select, text, whenNot } from '../fields.js';
import { ACTION_OUTS, CHANNEL, def, GUILD, MEMBER, trigger, USER } from './core.js';

// ---- flows that call flows ----------------------------------------------------------------------
/** The name a “Run Flow” block calls a “Called by Another Flow” trigger by. */
export const CALL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** How many flows deep a run may go (a flow that runs itself would otherwise never end). */
export const MAX_CALL_DEPTH = 20;
trigger('trigger.called', {
  label: 'Called by Another Flow', icon: '📥',
  description: 'Runs when a “Run Flow” block names it — from this flow or any other flow of this server. Put steps here that several flows share. The values the caller passes are {{arg.<name>}}; it works in the caller’s run, so what it stores in {{var.…}} is still there when the caller carries on.',
  fields: [
    text('name', 'Name', { required: true, placeholder: 'give-points', help: 'What a “Run Flow” block calls it by. Letters, numbers, - _ and . (max 64). Use each name once per server.' }),
  ],
  provides: () => [...USER, ...MEMBER, ...GUILD, ...CHANNEL, ['arg.<name>', 'A value passed by the Run Flow block (replace “name”)']],
  summary: (d) => d.name || '?',
  check: (d) => (d.name && !CALL_NAME_RE.test(String(d.name).trim()) ? ['The name can only use letters, numbers, - _ and . (max 64).'] : []),
});
def('logic.call', {
  category: 'connect', label: 'Run Flow', icon: '📤',
  description: 'Run the steps behind a “Called by Another Flow” trigger, wait until they are done, then continue here. Everything the run knows (who started it, the channel, {{var.…}}) goes along, and what those steps store in {{var.…}} comes back. Follows On error when they fail.',
  fields: [
    idField('name', 'Flow to run', 'callable', { required: true, placeholder: 'the name of a “Called by Another Flow” trigger', help: 'The flow it is in must be switched on.' }),
    list('args', 'Values to pass', {
      create: () => ({ name: 'value', value: '' }),
      label: (a) => `${a.name} = ${a.value}`,
      fields: [text('name', 'Name', { required: true, pattern: 'var', help: 'Read it there as {{arg.<name>}}.' }), text('value', 'Value', { placeholder: '{{option.amount}}' })],
    }),
  ],
  outputs: ACTION_OUTS,
  summary: (d) => d.name || '?',
});

// ---- when a run fails -----------------------------------------------------------------------------
trigger('trigger.flow.failed', {
  label: 'Flow Failed', icon: '🚨',
  description: 'Runs when a run of one of this server’s flows fails: a step ran into an error and nothing was connected to its On error output. Use it to tell your staff. {{failure.*}} says which flow and step, and why; {{user.*}} and {{channel.*}} are who and where it happened, when there was someone. A failure in a flow that this trigger started does not run it again.',
  fields: [idField('flow', 'Only for this flow (optional)', 'flow', { placeholder: 'blank = every flow' })],
  provides: () => [
    ...GUILD, ...USER, ...CHANNEL,
    ['failure.flow', 'Name of the flow that failed'], ['failure.message', 'What went wrong'], ['failure.node', 'The step it failed on (blank if unknown)'],
    ['failure.flowId', 'ID of the flow that failed'], ['failure.time', 'When it failed (ISO date)'],
  ],
  summary: (d) => (d.flow ? 'one flow' : 'any flow'),
});

// ---- asking a website ---------------------------------------------------------------------------
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const HTTP_MAX_HEADERS = 20;
def('action.http.request', {
  category: 'connect', label: 'HTTP Request', icon: '🌐', needs: 'http',
  description: 'Ask a website or an API for something, or send something to it, over https. The answer is {{http.status}}, {{http.text}} and — when it is JSON — {{http.body.<field>}}. Only public https addresses can be reached, and the bot operator must have switched this block on.',
  fields: [
    select('method', 'Method', HTTP_METHODS),
    text('url', 'Address', { required: true, placeholder: 'https://api.example.com/v1/things', help: 'A public https address. Private and internal addresses are refused.' }),
    list('headers', 'Headers', {
      create: () => ({ name: 'Authorization', value: '' }),
      label: (h) => h.name,
      fields: [text('name', 'Name', { required: true }), text('value', 'Value', { required: true })],
    }, { help: 'For example an API key. They are stored with the flow, so everyone who can edit this server’s flows can read them.' }),
    select('bodyType', 'Send', [['none', 'Nothing'], ['json', 'JSON'], ['form', 'Form fields (name=value&name=value)'], ['text', 'Plain text']], { showIf: whenNot('method', 'GET') }),
    area('body', 'What to send', {
      showIf: whenNot('bodyType', 'none'), rows: 4, placeholder: '{"name": {{user.name | json}}}',
      help: 'In JSON, write a value as {{user.name | json}} — without quotes around it — so that quotes or line breaks in it cannot break the JSON.',
    }),
    bool('failOnError', 'Follow On error when the site answers with an error (status 400 or higher)', { default: true }),
  ],
  outputs: ACTION_OUTS,
  provides: () => [
    ['http.status', 'The status the site answered with (200, 404 …)'], ['http.ok', 'true when the status is 200–299'], ['http.text', 'The answer as text (shortened)'],
    ['http.body.name', 'One field of a JSON answer (replace “name” with the field’s name)'], ['http.type', 'The kind of answer (its content type)'],
  ],
  summary: (d) => `${d.method || 'GET'} ${String(d.url || '?').replace(/^https:\/\//, '').slice(0, 40)}`,
  check(d) {
    const e = [];
    const url = String(d.url ?? '').trim();
    if (url && !url.includes('{{') && !/^https:\/\//i.test(url)) e.push('The address must start with https://.');
    if ((d.headers || []).length > HTTP_MAX_HEADERS) e.push(`At most ${HTTP_MAX_HEADERS} headers can be sent.`);
    if (d.method !== 'GET' && d.bodyType === 'json' && d.body && !String(d.body).includes('{{')) {
      try { JSON.parse(d.body); } catch { e.push('“What to send” is not valid JSON.'); }
    }
    return e;
  },
});
