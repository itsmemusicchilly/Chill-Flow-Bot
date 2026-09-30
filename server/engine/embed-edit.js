// "Change some parts of one embed": the embeds of a message that was already sent are edited as plain API data, so every part that is not
// named — and every other embed — comes back exactly as it was.
import { EmbedBuilder } from 'discord.js';
import { FlowError } from './errors.js';
import { checkEmbedLimits, cut, embedFieldsOf, embedPicture, embedUrl, EMPTY_EMBED_TEXT, parseColor } from './payload.js';

const rawOf = (e) => e?.toJSON?.() ?? e?.data ?? e;
/** Link previews, videos and the like are made by Discord itself: they are not ours to send back. */
export const isRich = (e) => { const type = rawOf(e)?.type; return !type || type === 'rich'; };

/** An embed in API shape, reduced to what can be sent back (no proxy addresses, sizes, provider or video). */
export function cleanEmbedJson(j) {
  const out = {};
  for (const k of ['title', 'description', 'url', 'timestamp', 'color']) if (j[k] !== undefined && j[k] !== null) out[k] = j[k];
  if (j.author?.name) out.author = { name: j.author.name, ...(j.author.url ? { url: j.author.url } : {}), ...(j.author.icon_url ? { icon_url: j.author.icon_url } : {}) };
  if (j.footer?.text) out.footer = { text: j.footer.text, ...(j.footer.icon_url ? { icon_url: j.footer.icon_url } : {}) };
  if (j.image?.url) out.image = { url: j.image.url };
  if (j.thumbnail?.url) out.thumbnail = { url: j.thumbnail.url };
  if (j.fields?.length) out.fields = j.fields.map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }));
  return out;
}

const REMOVE = {
  title: (e) => { delete e.title; delete e.url; },
  url: (e) => { delete e.url; },
  description: (e) => { delete e.description; },
  color: (e) => { delete e.color; },
  authorName: (e) => { delete e.author; },
  authorIcon: (e) => { if (e.author) delete e.author.icon_url; },
  authorUrl: (e) => { if (e.author) delete e.author.url; },
  thumbnail: (e) => { delete e.thumbnail; },
  image: (e) => { delete e.image; },
  footer: (e) => { delete e.footer; },
  footerIcon: (e) => { if (e.footer) delete e.footer.icon_url; },
  timestamp: (e) => { delete e.timestamp; },
  fields: (e) => { delete e.fields; },
};

/** Sets one part. An empty new value is an error (a variable that was never filled in), never a silent removal. */
function setPart(ctx, e, s) {
  const value = (label) => {
    const v = String(s.text ?? '').trim();
    if (!v) throw new FlowError(`“${label}” has no new value. To take a part off, use “Remove these parts”.`);
    return v;
  };
  switch (s.part) {
    case 'title': e.title = cut(value('Title'), 256); break;
    case 'url': e.url = embedUrl(value('Title link'), 'The title link'); break;
    case 'description': e.description = cut(value('Description'), 4096); break;
    case 'color': {
      const color = parseColor(s.color);
      if (color === null) throw new FlowError('The new color is not a color like #ff8800.');
      e.color = color;
      break;
    }
    case 'authorName': e.author = { ...e.author, name: cut(value('Author name'), 256) }; break;
    case 'authorIcon': e.author = { ...e.author, icon_url: embedPicture(ctx, s.image, 'The author icon') }; break;
    case 'authorUrl': e.author = { ...e.author, url: embedUrl(value('Author link'), 'The author link') }; break;
    case 'thumbnail': e.thumbnail = { url: embedPicture(ctx, s.image, 'Thumbnail') }; break;
    case 'image': e.image = { url: embedPicture(ctx, s.image, 'Image') }; break;
    case 'footer': e.footer = { ...e.footer, text: cut(value('Footer text'), 2048) }; break;
    case 'footerIcon': e.footer = { ...e.footer, icon_url: embedPicture(ctx, s.image, 'The footer icon') }; break;
    case 'timestamp': e.timestamp = new Date().toISOString(); break;
    case 'fields': {
      const fields = embedFieldsOf(s.fields);
      if (!fields.length) throw new FlowError('Add at least one field (a name and a value), or remove all the fields instead.');
      e.fields = fields;
      break;
    }
    default: throw new FlowError(`Unknown embed part “${s.part}”.`);
  }
}

/** The embed once every change is made — or null when nothing is left of it, so it disappears. */
function finish(e) {
  if (e.author && !e.author.name) throw new FlowError('The embed’s author needs a name (set the author name too).');
  if (e.footer && !e.footer.text) throw new FlowError('The embed’s footer needs text (set the footer text too).');
  if (!e.title) delete e.url;
  const body = e.title || e.description || e.fields?.length || e.image || e.author;
  if (!body && !e.thumbnail && !e.footer) return null;
  if (!body) e.description = EMPTY_EMBED_TEXT;
  return e;
}

/**
 * The embeds a message should have after "change some parts of embed N": parts to remove go first, then the parts to set.
 * One past the last embed adds a new one. Returns EmbedBuilders for ALL the message's embeds, because an edit replaces the whole list.
 */
export function patchEmbeds(ctx, d, message) {
  const current = (message.embeds || []).filter(isRich).map((e) => cleanEmbedJson(rawOf(e)));
  const n = Math.trunc(Number(d.patchEmbed) || 1);
  if (n < 1 || n > current.length + 1) {
    throw new FlowError(current.length
      ? `The message has ${current.length} embed${current.length === 1 ? '' : 's'}, so there is no embed number ${n} to change (use ${current.length + 1} to add a new one).`
      : 'The message has no embeds yet. Use embed number 1 to add one.');
  }
  const target = n <= current.length ? current[n - 1] : {};
  for (const key of d.patchRemove || []) {
    if (!REMOVE[key]) throw new FlowError(`Unknown embed part “${key}”.`);
    REMOVE[key](target);
  }
  for (const s of d.patchSet || []) setPart(ctx, target, s);
  const done = finish(target);
  const out = current.slice();
  if (n <= current.length) {
    if (done) out[n - 1] = done; else out.splice(n - 1, 1);
  } else if (done) {
    out.push(done);
  }
  const builders = out.map((j) => EmbedBuilder.from(j));
  checkEmbedLimits(builders);
  return builders;
}
