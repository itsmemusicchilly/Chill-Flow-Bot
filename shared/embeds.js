// The embeds of a message node. New nodes keep them in an `embeds` list (up to 10, each with every part below); nodes saved earlier kept ONE
// embed as flat keys (useEmbed, embedTitle, …). `embedsOf` reads either, so flows already stored, templates and exports keep working, and
// `upgradeMessageData` rewrites the old shape to the new one when a flow is saved or opened in the editor.
import { uid } from './util.js';

export const MAX_EMBEDS = 10;
export const MAX_EMBED_CHARS = 6000;

/** The parts of an embed a person can set (value) or remove. Removing the author name removes the whole author; removing the footer, the whole footer. */
export const EMBED_PARTS = [
  ['title', 'Title'], ['url', 'Title link'], ['description', 'Description'], ['color', 'Color'],
  ['authorName', 'Author name'], ['authorIcon', 'Author icon'], ['authorUrl', 'Author link'],
  ['thumbnail', 'Thumbnail'], ['image', 'Image'], ['footer', 'Footer text'], ['footerIcon', 'Footer icon'],
  ['timestamp', 'Timestamp'], ['fields', 'Fields'],
];

export const blankEmbed = () => ({
  id: uid(6), title: '', url: '', description: '', color: '#5865f2',
  authorName: '', authorIcon: '', authorUrl: '', thumbnail: '', image: '', footer: '', footerIcon: '', timestamp: false, fields: [],
});

const LEGACY = { embedTitle: 'title', embedDescription: 'description', embedColor: 'color', embedThumbnail: 'thumbnail', embedImage: 'image', embedFooter: 'footer', embedTimestamp: 'timestamp', embedFields: 'fields' };
const LEGACY_KEYS = ['useEmbed', ...Object.keys(LEGACY)];
const has = (d, k) => Object.prototype.hasOwnProperty.call(d, k);

/** The one embed a node saved with the flat keys means. A missing colour stays "no colour", exactly as it always did. */
function legacyEmbed(d) {
  const e = {
    id: 'e1', title: '', url: '', description: '', color: '', authorName: '', authorIcon: '', authorUrl: '',
    thumbnail: '', image: '', footer: '', footerIcon: '', timestamp: false, fields: [],
  };
  for (const [old, key] of Object.entries(LEGACY)) if (d[old] !== undefined && d[old] !== null) e[key] = d[old];
  if (!Array.isArray(e.fields)) e.fields = [];
  return e;
}

const hasEmbeds = (d) => Array.isArray(d?.embeds) && d.embeds.length > 0;

/**
 * The embeds a node means, whichever shape it is saved in. (Node data built from the catalog defaults carries an empty `embeds` list next to
 * the old flat keys, so an empty list does not hide an old-style embed.)
 */
export function embedsOf(d) {
  if (hasEmbeds(d)) return d.embeds;
  return d?.useEmbed ? [legacyEmbed(d)] : [];
}

const MESSAGE_NODES = new Set(['action.message.send', 'action.message.edit', 'action.message.buttons']);
const messageFromOf = (d) => (String(d.messageId ?? '').trim() ? 'id' : 'this');

/**
 * Rewrites a message node saved in an older shape to the current one — idempotent, and it returns the same object when there is nothing to change.
 *  - Send / Edit: the flat embed keys become an `embeds` list.
 *  - Edit: the choices that did not exist yet are written down as what the node always did (replace the text, replace or remove the embed, and a message named by ID).
 *  - Change Buttons: `messageFrom` is worked out from whether a message ID was given.
 */
export function upgradeMessageData(type, data) {
  if (!MESSAGE_NODES.has(type) || !data || typeof data !== 'object') return data;
  let d = data;
  if (type !== 'action.message.buttons' && !hasEmbeds(d) && LEGACY_KEYS.some((k) => has(d, k))) {
    const embeds = embedsOf(d);
    d = Object.fromEntries(Object.entries(d).filter(([k]) => !LEGACY_KEYS.includes(k)));
    d.embeds = embeds;
  }
  if (type === 'action.message.edit') {
    if (d.contentMode === undefined) d = { ...d, contentMode: 'replace' };
    if (d.embedsMode === undefined) d = { ...d, embedsMode: embedsOf(d).length ? 'replace' : 'remove' };
  }
  if ((type === 'action.message.edit' || type === 'action.message.buttons') && d.messageFrom === undefined) d = { ...d, messageFrom: messageFromOf(d) };
  return d;
}

/** Characters Discord counts towards the 6000 of a message, for one embed in API shape. */
export function embedChars(json) {
  return (json.title?.length || 0) + (json.description?.length || 0) + (json.author?.name?.length || 0) + (json.footer?.text?.length || 0)
    + (json.fields || []).reduce((n, f) => n + (f.name?.length || 0) + (f.value?.length || 0), 0);
}
