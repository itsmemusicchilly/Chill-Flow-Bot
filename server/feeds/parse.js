// Turns a downloaded feed into a list of items. Supports RSS 2.0, Atom (YouTube, Reddit, GitHub, Mastodon …), RSS 1.0 (RDF) and JSON Feed.
//
// The XML reader is written here on purpose and is deliberately dumb about the dangerous parts of XML:
//   - a <!DOCTYPE …> is skipped, never interpreted, and only the five built-in entities and numeric character references are
//     decoded — a custom `<!ENTITY …>` is never expanded, so "billion laughs" and external-file tricks (XXE) have nothing to work with;
//   - nesting depth, element count and attribute count are capped, and reading is a single linear pass (no backtracking patterns);
//   - everything that comes out is plain text: markup is stripped, control characters removed, links must be http(s), pictures https.
import crypto from 'node:crypto';

export class FeedError extends Error {}

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 100_000;
const MAX_ATTRS = 50;
export const MAX_ITEMS = 100;

// ---- text helpers ----------------------------------------------------------------------------------------------------------------
// C0 controls except tab/newline/carriage return, DEL–C1, line/paragraph separators and bidi overrides — written as escapes so this file holds none of them
const UNSAFE = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F${String.fromCharCode(0x2028, 0x2029)}\\u202A-\\u202E\\u2066-\\u2069]`, 'g');
const tidy = (s) => String(s ?? '').replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const HTML_ENTITIES = { ...XML_ENTITIES, nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', middot: '·', bull: '•' };
function codePoint(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
  if (n < 0x20 && ![9, 10, 13].includes(n)) return null;
  return String.fromCodePoint(n);
}
/** Decodes built-in and numeric entities. A named entity we do not know (a custom one) is left exactly as written; a numeric one that is not a real character is dropped. */
export function decodeEntities(s, table = XML_ENTITIES) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,8});/g, (whole, body) => {
    if (body[0] === '#') return codePoint(body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)) ?? ''; // an impossible character is dropped
    return Object.hasOwn(table, body) ? table[body] : whole;
  });
}

/** HTML → plain text: tags gone, line breaks kept where the markup had them, entities decoded. */
export function htmlToText(html) {
  const s = String(html ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ''); // inline tags (<b>, <a>, <span> …) leave no gap: “<b>everything</b>.” is “everything.”
  return decodeEntities(s, HTML_ENTITIES).replace(UNSAFE, '').replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const httpUrl = (v) => {
  const s = tidy(v);
  if (!s || s.length > 2000) return '';
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { return ''; }
};
const httpsUrl = (v) => { const u = httpUrl(v); return u.startsWith('https:') ? u : ''; };
const isoDate = (v) => { const t = Date.parse(String(v ?? '').trim()); return Number.isFinite(t) && t > 0 && t < 4102444800000 ? new Date(t).toISOString() : ''; };

// ---- the XML reader ----------------------------------------------------------------------------------------------------------------
const NAME_START = /[A-Za-z_:]/;
const ATTR = /\s*([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/y;

/** @returns {{name: string, attrs: object, children: object[], text: string}} the root element */
export function parseXml(input) {
  const s = String(input);
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  let elements = 0;
  const top = () => stack[stack.length - 1];
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { top().text += decodeEntities(s.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(s.slice(i, lt));
    i = lt;
    if (s.startsWith('<!--', i)) { const end = s.indexOf('-->', i + 4); i = end === -1 ? s.length : end + 3; continue; }
    if (s.startsWith('<![CDATA[', i)) { const end = s.indexOf(']]>', i + 9); top().text += s.slice(i + 9, end === -1 ? s.length : end); i = end === -1 ? s.length : end + 3; continue; }
    if (s.startsWith('<?', i)) { const end = s.indexOf('?>', i + 2); i = end === -1 ? s.length : end + 2; continue; }
    if (s.startsWith('<!', i)) { // <!DOCTYPE …>, possibly with an internal subset in [ … ]: skipped whole, never read
      let depth = 0; let j = i + 2;
      for (; j < s.length; j += 1) { const c = s[j]; if (c === '[') depth += 1; else if (c === ']') depth -= 1; else if (c === '>' && depth <= 0) break; }
      i = j + 1; continue;
    }
    if (s[i + 1] === '/') { // closing tag: close the nearest open element of that name (tolerates sloppy feeds)
      const end = s.indexOf('>', i + 2);
      const name = s.slice(i + 2, end === -1 ? s.length : end).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k -= 1) if (stack[k].name === name) { stack.length = k; break; }
      i = end === -1 ? s.length : end + 1; continue;
    }
    if (!NAME_START.test(s[i + 1] ?? '')) { top().text += '<'; i += 1; continue; } // a stray "<" in text
    // an opening tag
    let j = i + 1;
    while (j < s.length && !/[\s/>]/.test(s[j])) j += 1;
    const name = s.slice(i + 1, j).toLowerCase();
    const attrs = {};
    let count = 0;
    let selfClosing = false;
    for (;;) {
      while (j < s.length && /\s/.test(s[j])) j += 1;
      if (j >= s.length) break;
      if (s[j] === '>') { j += 1; break; }
      if (s[j] === '/' && s[j + 1] === '>') { selfClosing = true; j += 2; break; }
      if (s[j] === '/') { j += 1; continue; }
      ATTR.lastIndex = j;
      const m = ATTR.exec(s);
      if (!m || ATTR.lastIndex === j) { j += 1; continue; }
      j = ATTR.lastIndex;
      count += 1;
      if (count <= MAX_ATTRS) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    elements += 1;
    if (elements > MAX_ELEMENTS) throw new FeedError('This feed is too complicated to read (too many elements).');
    const el = { name, attrs, children: [], text: '' };
    top().children.push(el);
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) throw new FeedError('This feed is too complicated to read (nested too deeply).');
      stack.push(el);
    }
    i = j;
  }
  return root;
}

// ---- looking things up in the tree ---------------------------------------------------------------------------------------------------
const kids = (el, name) => el.children.filter((c) => c.name === name);
const first = (el, ...names) => { for (const n of names) { const f = el.children.find((c) => c.name === n); if (f) return f; } return null; };
const text = (el, ...names) => { const f = el ? first(el, ...names) : null; return f ? f.text : ''; };
/** First descendant with this name (breadth of the document order), for things nested in groups like <media:group>. */
function deep(el, name, limit = 400) {
  const queue = [...el.children];
  for (let n = 0; queue.length && n < limit; n += 1) {
    const c = queue.shift();
    if (c.name === name) return c;
    queue.push(...c.children);
  }
  return null;
}
/** A title is plain text unless the feed says it is HTML (Atom `type="html"`), so “I <3 pizza and x > y” stays as written. */
function titleOf(el) {
  const t = first(el, 'title');
  if (!t) return '';
  return /^x?html$/i.test(t.attrs.type ?? '') ? tidy(htmlToText(t.text)) : tidy(t.text);
}

function firstImage(html) {
  const m = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(String(html ?? ''));
  return m ? httpsUrl(decodeEntities(m[1] ?? m[2] ?? '')) : '';
}

function hash(...parts) { return crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 24); }

function finishItem({ id, title, link, author, published, summary, image }) {
  const t = clip(tidy(title), 256);
  const l = httpUrl(link);
  const p = isoDate(published);
  const s = clip(htmlToText(summary), 500);
  const key = tidy(id).slice(0, 500) || l || (t || p ? hash(t, p) : '');
  if (!key) return null;
  return { id: key, title: t, link: l, author: clip(tidy(author), 100), published: p, summary: s, image: httpsUrl(image) };
}

// ---- RSS 2.0 / RSS 1.0 ---------------------------------------------------------------------------------------------------------------
function rssItem(it) {
  const description = text(it, 'content:encoded') || text(it, 'description') || text(it, 'summary');
  const thumb = first(it, 'media:thumbnail') ?? deep(it, 'media:thumbnail');
  const media = kids(it, 'media:content').find((m) => /^image/i.test(m.attrs.type || m.attrs.medium || '')) ?? null; // the type wins: Mastodon calls a video medium="image"
  const enclosure = kids(it, 'enclosure').find((e) => /^image\//i.test(e.attrs.type ?? '')) ?? null;
  const atomLink = kids(it, 'atom:link').find((l) => (l.attrs.rel ?? 'alternate') === 'alternate');
  return finishItem({
    id: text(it, 'guid') || text(it, 'id'),
    title: titleOf(it),
    link: text(it, 'link') || atomLink?.attrs.href || '',
    author: text(it, 'dc:creator') || text(it, 'author') || text(it, 'itunes:author'),
    published: text(it, 'pubdate') || text(it, 'dc:date') || text(it, 'published') || text(it, 'updated'),
    summary: description,
    image: thumb?.attrs.url || media?.attrs.url || enclosure?.attrs.url || firstImage(text(it, 'content:encoded') || text(it, 'description')),
  });
}

// ---- Atom ------------------------------------------------------------------------------------------------------------------------------
function atomItem(en) {
  const links = kids(en, 'link');
  const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate') ?? links.find((l) => l.attrs.rel !== 'self' && l.attrs.rel !== 'replies' && l.attrs.href);
  const content = first(en, 'content', 'summary') ?? deep(en, 'media:description');
  const thumb = first(en, 'media:thumbnail') ?? deep(en, 'media:thumbnail');
  return finishItem({
    id: text(en, 'id') || text(en, 'yt:videoid'),
    title: titleOf(en),
    link: alt?.attrs.href || '',
    author: text(first(en, 'author') ?? { children: [] }, 'name'),
    published: text(en, 'published') || text(en, 'updated'),
    summary: content ? content.text : '',
    image: thumb?.attrs.url || firstImage(content?.text),
  });
}

// ---- JSON Feed ----------------------------------------------------------------------------------------------------------------------------
function jsonFeed(doc) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const items = (Array.isArray(doc.items) ? doc.items : []).slice(0, MAX_ITEMS).map((it) => {
    const authors = Array.isArray(it?.authors) ? it.authors : it?.author ? [it.author] : [];
    return finishItem({
      id: typeof it?.id === 'number' ? String(it.id) : str(it?.id), title: str(it?.title), link: str(it?.url) || str(it?.external_url),
      author: str(authors[0]?.name), published: str(it?.date_published) || str(it?.date_modified),
      summary: str(it?.summary) || str(it?.content_text) || str(it?.content_html), image: str(it?.image) || str(it?.banner_image),
    });
  }).filter(Boolean);
  return { title: clip(tidy(str(doc.title)), 256), items };
}

/**
 * @param {string} body the downloaded text
 * @returns {{title: string, items: {id: string, title: string, link: string, author: string, published: string, summary: string, image: string}[]}}
 * @throws {FeedError} when it is not a feed we can read
 */
export function parseFeed(body) {
  const src = String(body ?? '').replace(/^\ufeff/, '');
  const head = src.trimStart();
  if (!head) throw new FeedError('The address answered with nothing.');
  if (head[0] === '{') {
    let doc;
    try { doc = JSON.parse(head); } catch { throw new FeedError('That looks like JSON, but it could not be read.'); }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.items)) throw new FeedError('That JSON is not a feed (it has no “items”).');
    return jsonFeed(doc);
  }
  const root = parseXml(head);
  const rss = first(root, 'rss');
  const atom = first(root, 'feed', 'atom:feed');
  const rdf = first(root, 'rdf:rdf');
  if (rss) {
    const channel = first(rss, 'channel') ?? rss;
    return { title: clip(titleOf(channel), 256), items: kids(channel, 'item').slice(0, MAX_ITEMS).map(rssItem).filter(Boolean) };
  }
  if (atom) {
    return { title: clip(titleOf(atom), 256), items: kids(atom, 'entry').slice(0, MAX_ITEMS).map(atomItem).filter(Boolean) };
  }
  if (rdf) {
    const channel = first(rdf, 'channel');
    return { title: clip(titleOf(channel ?? rdf), 256), items: kids(rdf, 'item').slice(0, MAX_ITEMS).map(rssItem).filter(Boolean) };
  }
  if (/^<!doctype html|^<html[\s>]/i.test(head)) throw new FeedError('That address is a web page, not a feed. Look for the feed (RSS/Atom) link of the site.');
  throw new FeedError('That is not an RSS, Atom or JSON feed.');
}
