// Page blocks: the building material of the website builder. Defined with the same field DSL as flow nodes, so the
// editor's inspector renders them with no extra code. Pages are pure data — never HTML — which is what lets the renderer
// (render-page.js) guarantee that nothing an admin types can become script.
import { area, bool, checkFields, color, defaultsForFields, image, list, num, select, text, when } from './fields.js';
import { CHOICE_TYPES, FIELD_ID_RE, RESERVED_FIELD_IDS, parseOptions } from './forms.js';
import { isCapped, LIMITS } from './limits.js';
import { looksLikeUpload, safeUrl, uploadIdOf } from './urls.js';
import { uid } from './util.js';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,12}$/;
export const MAX_BLOCK_BYTES = 128 * 1024; // physical ceiling per block
export const MAX_PAGE_BYTES = 2 * 1024 * 1024; // physical ceiling per page

export const THEME_DEFAULTS = { mode: 'dark', accent: '#5865f2', width: 'normal' };
export const THEME_FIELDS = [
  select('mode', 'Look', [['dark', 'Dark'], ['light', 'Light']]),
  color('accent', 'Accent colour'),
  select('width', 'Page width', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']], { default: 'normal' }),
];

const ALIGN = select('align', 'Alignment', [['left', 'Left'], ['center', 'Centred']], { default: 'left' });
const urlProblem = (value, label, httpsOnly = false) => (value && !safeUrl(value, { httpsOnly }) ? [`${label} must be a full ${httpsOnly ? 'https' : 'http(s)'} link.`] : []);
/** An image field holds an uploaded picture (`upload:<id>`, checked by checkFields) or an https link. */
const imageProblem = (value, label) => (looksLikeUpload(value) ? [] : urlProblem(value, label, true));

const FIELD_TYPES = [
  ['short', 'Short answer'], ['long', 'Long answer'], ['number', 'Number'], ['select', 'Dropdown'], ['radio', 'Pick one (radio buttons)'],
  ['checkboxes', 'Pick many (checkboxes)'], ['agree', 'Single tick box (“I agree”)'], ['date', 'Date'],
];

export const BLOCK_TYPES = {};
const def = (type, d) => { BLOCK_TYPES[type] = { type, ...d }; };

def('hero', {
  label: 'Hero', icon: '🌟', description: 'A big title with an optional subtitle, background image and button.',
  fields: [
    text('title', 'Title', { default: 'Welcome' }), text('subtitle', 'Subtitle'),
    image('imageUrl', 'Background image'), text('buttonLabel', 'Button label'), text('buttonUrl', 'Button link'),
    { ...ALIGN, default: 'center' },
  ],
  summary: (d) => d.title,
  check: (d) => [...imageProblem(d.imageUrl, 'The background image'), ...urlProblem(d.buttonUrl, 'The button link'), ...(d.buttonLabel && !d.buttonUrl ? ['The button needs a link.'] : [])],
});
def('heading', {
  label: 'Heading', icon: '🔤', description: 'A section heading.',
  fields: [text('text', 'Text', { default: 'A heading', required: true }), select('level', 'Size', [['1', 'Large'], ['2', 'Medium'], ['3', 'Small']], { default: '2' }), ALIGN],
  summary: (d) => d.text,
});
def('text', {
  label: 'Text', icon: '📝', description: 'A paragraph. Use **bold**, *italic* and [links](https://example.com). Blank line = new paragraph.',
  fields: [area('body', 'Text', { default: 'Write something here…', rows: 6, required: true }), ALIGN],
  summary: (d) => d.body,
});
def('image', {
  label: 'Image', icon: '🖼️', description: 'A picture: upload one from your computer, or paste an https link.',
  fields: [
    image('url', 'Image', { required: true }), text('alt', 'Description (for screen readers)'), text('caption', 'Caption'),
    text('link', 'Make it a link (optional)'), select('width', 'Size', [['full', 'Full width'], ['medium', 'Medium'], ['small', 'Small']], { default: 'full' }),
  ],
  summary: (d) => d.alt || (uploadIdOf(d.url) ? 'Uploaded image' : d.url),
  check: (d) => [...imageProblem(d.url, 'The image'), ...urlProblem(d.link, 'The link')],
});
def('button', {
  label: 'Button', icon: '🔘', description: 'A button that links to another page, e.g. your Discord invite.',
  fields: [text('label', 'Label', { default: 'Join our server', required: true }), text('url', 'Link', { required: true }), select('style', 'Style', [['primary', 'Filled'], ['outline', 'Outline']]), ALIGN],
  summary: (d) => d.label,
  check: (d) => urlProblem(d.url, 'The link'),
});
def('list', {
  label: 'List', icon: '📋', description: 'A bulleted, numbered or checklist.',
  fields: [area('items', 'Items (one per line)', { default: 'First\nSecond\nThird', rows: 5, required: true }), select('style', 'Style', [['bullets', 'Bullets'], ['numbers', 'Numbers'], ['checks', 'Checks']])],
  summary: (d) => String(d.items ?? '').split('\n')[0],
});
def('divider', { label: 'Divider', icon: '➖', description: 'A thin line between sections.', fields: [], summary: () => '' });
def('spacer', {
  label: 'Spacer', icon: '↕️', description: 'Empty space.',
  fields: [select('size', 'Size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], { default: 'm' })], summary: (d) => d.size,
});
def('form', {
  label: 'Form', icon: '🧾', description: 'Collect answers from people who log in with Discord. A “Form Submitted” flow can react to each response.',
  fields: [
    text('title', 'Form title', { default: 'Apply', required: true }),
    area('intro', 'Introduction', { rows: 3 }),
    list('fields', 'Questions', {
      create: () => ({ id: `q_${uid(4)}`, label: 'Your question', type: 'short', required: true, placeholder: '', help: '', options: '', min: '', max: '' }),
      label: (q) => q.label,
      fields: [
        text('id', 'ID (the answer is {{form.ID}} in flows)', { required: true }),
        text('label', 'Question', { required: true }),
        select('type', 'Answer type', FIELD_TYPES),
        bool('required', 'Required'),
        text('placeholder', 'Placeholder', { showIf: when('type', 'short', 'long', 'number') }),
        area('options', 'Options (one per line)', { showIf: when('type', ...CHOICE_TYPES), rows: 4, required: true }),
        num('min', 'Minimum (length, or value for numbers)', { showIf: when('type', 'short', 'long', 'number') }),
        num('max', 'Maximum (length, or value for numbers)', { showIf: when('type', 'short', 'long', 'number') }),
        text('help', 'Help text'),
      ],
    }),
    text('submitLabel', 'Button label', { default: 'Submit' }),
    bool('requireMember', 'Only members of this server can submit', { default: true, help: 'Checked live through the bot. Turn off for public applications.' }),
    bool('oneResponsePerUser', 'One response per person'),
    num('cooldownMinutes', 'Wait between responses (minutes)', { min: 0, help: 'Blank or 0 = no wait.' }),
    bool('saveResponses', 'Save responses in the dashboard', { default: true, help: 'Turn off if you only want the flow to react. If “one response per person” or a wait is on, a receipt (who and when — no answers) is still kept so those rules work.' }),
    select('onSuccess', 'After submitting', [['message', 'Show a thank-you message'], ['redirect', 'Go to another web address']]),
    area('successMessage', 'Thank-you message', { default: 'Thanks! Your response was sent.', rows: 3, showIf: when('onSuccess', 'message') }),
    text('redirectUrl', 'Go to (link)', { showIf: when('onSuccess', 'redirect'), required: true }),
  ],
  summary: (d) => `${d.title} · ${(d.fields || []).length} question(s)`,
  check(d) {
    const e = [];
    const qs = d.fields || [];
    if (!qs.length) e.push('Add at least one question.');
    const seen = new Set();
    for (const q of qs) {
      if (q.id && !FIELD_ID_RE.test(q.id)) e.push(`Question ID “${q.id}” must be letters, numbers or _ (max 32) and not start with a number.`);
      if (RESERVED_FIELD_IDS.includes(q.id)) e.push(`“${q.id}” is reserved — pick another question ID.`);
      if (seen.has(q.id)) e.push(`Duplicate question ID “${q.id}”.`);
      seen.add(q.id);
      if (CHOICE_TYPES.includes(q.type) && !parseOptions(q.options).length) e.push(`Question “${q.label}” needs at least one option.`);
      if (q.min !== '' && q.max !== '' && q.min !== undefined && q.max !== undefined && Number(q.min) > Number(q.max)) e.push(`Question “${q.label}”: the minimum is above the maximum.`);
    }
    if (d.onSuccess === 'redirect') e.push(...urlProblem(d.redirectUrl, 'The redirect address'));
    return e;
  },
});

export const BLOCK_LIST = Object.values(BLOCK_TYPES);
export const defaultBlockData = (type) => defaultsForFields(BLOCK_TYPES[type]?.fields);
export const newBlock = (type, id = uid(6)) => ({ id, type, data: defaultBlockData(type) });

/** Every form on a page, for the flow trigger's picker and for the variable chips. */
export function formsOf(page) {
  return (page?.blocks || []).filter((b) => b.type === 'form').map((b) => ({
    blockId: b.id, title: b.data.title || 'Form', fields: (b.data.fields || []).map((q) => ({ id: q.id, label: q.label, type: q.type })),
  }));
}

/** Keep only what we store. */
export function normalizePage(input) {
  const theme = { ...THEME_DEFAULTS, ...(input?.theme && typeof input.theme === 'object' ? input.theme : {}) };
  return {
    title: String(input?.title ?? '').trim().slice(0, 80),
    slug: String(input?.slug ?? '').trim().toLowerCase(),
    published: Boolean(input?.published),
    theme: { mode: theme.mode === 'light' ? 'light' : 'dark', accent: /^#[0-9a-f]{6}$/i.test(theme.accent) ? theme.accent : THEME_DEFAULTS.accent, width: ['narrow', 'normal', 'wide'].includes(theme.width) ? theme.width : 'normal' },
    blocks: (Array.isArray(input?.blocks) ? input.blocks : []).map((b) => ({
      id: String(b?.id ?? ''), type: String(b?.type ?? ''), data: b?.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {},
    })),
  };
}

/**
 * @param {{uploads?: Set<string>}} [known] the ids of this server's uploaded images, when known: a picture that was deleted
 *   since it was chosen is then reported (as a warning: the page still publishes, that spot just shows nothing)
 * @returns {{blockId: string|null, level: 'error'|'warning', kind: 'structure'|'config'|'image', message: string}[]}
 * `structure` issues make a page unsavable; `config` issues are shown as to-dos and block *publishing* forms with problems.
 */
export function validatePage(page, { uploads } = {}) {
  const issues = [];
  const add = (blockId, kind, message) => issues.push({ blockId, level: 'error', kind, message });
  if (!page.title) add(null, 'config', 'Give the page a title.');
  if (!SLUG_RE.test(page.slug)) add(null, 'structure', 'The web address must be 1–40 lowercase letters, numbers or dashes (not starting or ending with a dash).');
  if (isCapped(LIMITS.blocksPerPage) && page.blocks.length > LIMITS.blocksPerPage) add(null, 'structure', `A page can have at most ${LIMITS.blocksPerPage} blocks.`);
  if (JSON.stringify(page.blocks).length > MAX_PAGE_BYTES) add(null, 'structure', 'This page holds too much content.');
  const ids = new Set();
  for (const b of page.blocks) {
    if (!BLOCK_ID_RE.test(b.id) || ids.has(b.id)) { add(null, 'structure', `Invalid or duplicate block id “${b.id}”.`); continue; }
    ids.add(b.id);
    const d = BLOCK_TYPES[b.type];
    if (!d) { add(b.id, 'structure', `Unknown block type “${b.type}”.`); continue; }
    if (JSON.stringify(b.data).length > MAX_BLOCK_BYTES) { add(b.id, 'structure', 'This block holds too much content.'); continue; }
    checkFields(d.fields, b.data, '', (m) => add(b.id, 'config', m));
    for (const m of d.check?.(b.data) || []) add(b.id, 'config', m);
    if (uploads) {
      for (const f of d.fields) {
        const id = f.type === 'image' ? uploadIdOf(b.data[f.key]) : null;
        if (id && !uploads.has(id)) issues.push({ blockId: b.id, level: 'warning', kind: 'image', message: `“${f.label}”: that uploaded image no longer exists. Choose another one.` });
      }
    }
  }
  return issues;
}
export const hasPageStructureErrors = (issues) => issues.some((i) => i.kind === 'structure');
