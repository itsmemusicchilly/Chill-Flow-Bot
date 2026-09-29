// Component custom ids carry everything needed to route a click, so buttons keep working after restarts.
//
//   fc:<flowId>:<nodeId>:<handle>:<invokerId?>   a button/menu wired to an output of one Send Message node
//   fcb:<buttonId>:<invokerId?>                  a reusable button, handled by a "Button Clicked" trigger with that ID
//
// `fcb:` ids do not mention a flow or node, so the panel keeps working when flows are duplicated, imported or rebuilt.
import { BUTTON_ID_RE } from '../../shared/catalog.js';

const MAX_LEN = 100;

export function buildCustomId({ flowId, nodeId, handle, invokerId = '' }) {
  const id = ['fc', flowId, nodeId, handle, invokerId].join(':');
  if (id.length > MAX_LEN) throw new Error('Component id too long');
  return id;
}

export function parseCustomId(id) {
  const p = String(id).split(':');
  if (p[0] !== 'fc' || p.length < 4) return null;
  return { flowId: p[1], nodeId: p[2], handle: p[3], invokerId: p[4] || '' };
}

export function buildButtonId({ id, invokerId = '' }) {
  if (!BUTTON_ID_RE.test(id)) throw new Error('Invalid Button ID');
  const out = ['fcb', id, invokerId].join(':');
  if (out.length > MAX_LEN) throw new Error('Component id too long');
  return out;
}

export function parseButtonId(customId) {
  const p = String(customId).split(':');
  if (p[0] !== 'fcb' || p.length < 2 || !BUTTON_ID_RE.test(p[1])) return null;
  return { id: p[1], invokerId: p[2] || '' };
}
