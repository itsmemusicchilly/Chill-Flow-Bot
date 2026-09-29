// Generates docs/NODES.md from shared/catalog.js so the reference can never drift from the editor.
//   npm run docs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, defaultsFor, getOutputs, NODE_LIST } from '../shared/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function fieldRows(fields, indent = '') {
  const rows = [];
  for (const f of fields) {
    const notes = [];
    if (f.required) notes.push('required');
    if (f.showIf) notes.push(`shown when \`${f.showIf.key}\` ${f.showIf.in ? `is ${f.showIf.in.map((v) => `\`${v}\``).join(' / ')}` : `is not ${f.showIf.notIn.map((v) => `\`${v}\``).join(' / ')}`}`);
    if (f.type === 'select' || f.type === 'multiselect') notes.push(`options: ${f.options.map((o) => o.label).join(', ')}`);
    if (f.type === 'list' && Number.isFinite(f.max)) notes.push(`up to ${f.max} items`);
    else if (f.type !== 'list' && (f.min !== undefined || f.max !== undefined)) notes.push(`range ${f.min ?? '…'}–${f.max ?? '…'}`);
    if (f.help) notes.push(f.help);
    rows.push(`| ${indent}${esc(f.label)} | ${f.type === 'id' ? f.kind : f.type} | ${esc(notes.join('; '))} |`);
    if (f.type === 'list') rows.push(...fieldRows(f.item.fields, `${indent}↳ `));
  }
  return rows;
}

const out = [
  '# Node reference',
  '',
  '> Generated from `shared/catalog.js` by `npm run docs` — do not edit by hand.',
  '',
  'Text fields accept `{{variables}}` (see the README). Every action also has an **On error** output; connect it to handle',
  'failures, and read `{{error.message}}` there. Fields left blank on channel/role/user pickers usually mean “the one that',
  'triggered this flow”.',
  '',
];

for (const [key, cat] of Object.entries(CATEGORIES)) {
  const nodes = NODE_LIST.filter((n) => n.category === key);
  if (!nodes.length) continue;
  out.push(`## ${cat.label}`, '');
  for (const n of nodes) {
    out.push(`### ${n.icon} ${n.label}`, '', `\`${n.type}\` — ${n.description}`, '');
    if (n.requires) out.push(`> Needs the **${n.requires === 'members' ? 'Server Members' : 'Message Content'}** privileged intent (the bot operator must enable it).`, '');
    const rows = fieldRows(n.fields);
    if (rows.length) out.push('| Field | Type | Notes |', '| --- | --- | --- |', ...rows, '');
    const outputs = getOutputs(n.type, defaultsFor(n.type));
    if (!n.isTrigger || outputs.length > 1) out.push(`**Outputs:** ${outputs.map((o) => o.label).join(', ')}${n.type === 'action.message.send' ? ' — plus one per button and menu option (a button with a Button ID has no output: a “Button Clicked” trigger handles it instead)' : ''}`, '');
    const provides = n.provides?.(defaultsFor(n.type)) ?? [];
    if (provides.length) out.push(`**Adds variables:** ${provides.map(([p]) => `\`{{${p}}}\``).join(', ')}`, '');
  }
}

fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/NODES.md'), `${out.join('\n')}\n`);
console.log(`Wrote docs/NODES.md (${NODE_LIST.length} nodes)`);
