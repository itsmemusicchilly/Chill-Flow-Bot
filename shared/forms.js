// Server-side validation of a submitted web form. The browser's own checks are only a convenience — this is authoritative.
// Pure functions: `input` is whatever the request body held (strings or arrays of strings).
export const ANSWER_MAX = 10000; // physical ceiling per answer, not a policy limit
export const FIELD_ID_RE = /^[A-Za-z_]\w{0,31}$/;
export const RESERVED_FIELD_IDS = ['title', 'summary', 'all'];
export const CHOICE_TYPES = ['select', 'radio', 'checkboxes'];

/** One option per line, trimmed, no blanks or duplicates. */
export function parseOptions(text) {
  return [...new Set(String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))].slice(0, 200);
}

// Control characters (except tab/newline) have no business in an answer and can confuse logs and CSV readers.
const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
const first = (v) => (Array.isArray(v) ? v[0] : v);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const has = (v) => v !== undefined && v !== null && String(v) !== '';

/**
 * @param {{fields: object[]}} form  the form block's data
 * @param {Record<string, string|string[]>} input  values keyed `f_<fieldId>`
 * @returns {{ok: boolean, answers: Record<string, string|number|string[]>, errors: Record<string,string>, values: Record<string, string|string[]>}}
 */
export function validateSubmission(form, input = {}) {
  const answers = {};
  const errors = {};
  const values = {}; // what to show again if something is wrong
  for (const q of form.fields || []) {
    const raw = input[`f_${q.id}`];
    const required = Boolean(q.required);
    const min = has(q.min) ? Number(q.min) : undefined;
    const max = has(q.max) ? Number(q.max) : undefined;
    const fail = (msg) => { errors[q.id] = msg; };
    switch (q.type) {
      case 'checkboxes': {
        const options = parseOptions(q.options);
        const picked = [...new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(clean))];
        values[q.id] = picked;
        if (picked.some((p) => !options.includes(p))) fail('Choose only from the options shown.');
        else if (required && !picked.length) fail('Choose at least one.');
        else answers[q.id] = picked;
        break;
      }
      case 'select':
      case 'radio': {
        const v = clean(first(raw)).trim();
        values[q.id] = v;
        if (!v) { if (required) fail('This question is required.'); else answers[q.id] = ''; }
        else if (!parseOptions(q.options).includes(v)) fail('Choose one of the options shown.');
        else answers[q.id] = v;
        break;
      }
      case 'agree': {
        const checked = has(first(raw));
        values[q.id] = checked ? 'on' : '';
        if (required && !checked) fail('You need to tick this to continue.');
        else answers[q.id] = checked ? 'Yes' : 'No';
        break;
      }
      case 'number': {
        const s = clean(first(raw)).trim();
        values[q.id] = s;
        if (!s) { if (required) fail('This question is required.'); else answers[q.id] = ''; break; }
        const n = Number(s);
        if (!Number.isFinite(n)) fail('Enter a number.');
        else if (min !== undefined && n < min) fail(`Must be at least ${min}.`);
        else if (max !== undefined && n > max) fail(`Must be at most ${max}.`);
        else answers[q.id] = n;
        break;
      }
      case 'date': {
        const s = clean(first(raw)).trim();
        values[q.id] = s;
        if (!s) { if (required) fail('This question is required.'); else answers[q.id] = ''; }
        else if (!isDate(s)) fail('Enter a valid date.');
        else answers[q.id] = s;
        break;
      }
      default: { // 'short' and 'long'
        let s = clean(first(raw));
        if (q.type !== 'long') s = s.replace(/\n/g, ' ');
        s = s.trim();
        values[q.id] = s;
        if (!s) { if (required) fail('This question is required.'); else answers[q.id] = ''; break; }
        if (s.length > ANSWER_MAX) fail(`Too long (at most ${ANSWER_MAX} characters).`);
        else if (min !== undefined && s.length < min) fail(`Write at least ${min} characters.`);
        else if (max !== undefined && s.length > max) fail(`Write at most ${max} characters.`);
        else answers[q.id] = s;
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, answers, errors, values };
}

export const answerText = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

/** "Label: value" lines — handy for pasting a whole response into a message. */
export function summarize(form, answers) {
  return (form.fields || []).map((q) => `${q.label}: ${answerText(answers[q.id]) || '—'}`).join('\n');
}
