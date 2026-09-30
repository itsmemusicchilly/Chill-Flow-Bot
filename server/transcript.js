// Builds the .html transcript of a channel (used when a ticket is closed), and optionally a plain .txt copy of the same messages.
// Pure: the executor turns Discord messages into plain records, this file turns records into documents. Nothing here imports discord.js.
//
// Security model (the text comes from anyone who could type in the channel, and the file is opened in a browser by staff):
//   - every interpolated value is escaped (esc) and stripped of control and bidi-override characters;
//   - there is no script, no inline handler, no <img>, no CSS url(); a CSP <meta> forbids everything except inline CSS;
//   - message text is never turned into links; the only links are attachment URLs that pass safeUrl (https only), and they
//     are labelled as temporary because Discord's file links expire and vanish with the channel;
//   - the file name is an ASCII slug;
//   - in the .txt every line of message text is indented, so a member cannot type a line that looks like a message header (who wrote
//     what, when), and line-break characters other than \n are removed.
import { esc } from '../shared/render-page.js';
import { safeUrl } from '../shared/urls.js';

/** A physical ceiling, not a policy limit: below what Discord accepts as an upload (believed 10 MiB; not verified here). It covers
 *  the .html and the .txt TOGETHER, because both go out in one message. */
export const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

// control characters (keeps \t \n \r), line/paragraph separators, and the bidi overrides that can make text look reordered
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
const clean = (s) => String(s ?? '').replace(UNSAFE, '');
const oneLine = (s) => clean(s).replace(/\s+/g, ' ').trim();
const text = (s) => esc(clean(s));
const line = (s) => esc(oneLine(s));

const pad = (n) => String(n).padStart(2, '0');
const utc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;

export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** `transcript-<ascii-slug>-YYYY-MM-DD-HHmm.html` (or `.txt`) — the slug is [a-z0-9-] only, so the name is safe everywhere. */
export function transcriptFileName(channelName, date = new Date(), ext = 'html') {
  const slug = String(channelName ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'channel';
  const stamp = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
  return `transcript-${slug}-${stamp}.${ext === 'txt' ? 'txt' : 'html'}`;
}

const CSS = `
:root{color-scheme:dark}
body{margin:0;background:#1e1f22;color:#dbdee1;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px;color:#fff}
.meta{color:#949ba4;font-size:13px;margin:0 0 18px}
.notice{background:#3b2f1c;border:1px solid #7a5b1d;color:#f0d9a3;border-radius:6px;padding:10px 12px;margin:0 0 16px;font-size:14px}
.msg{padding:8px 10px;border-radius:6px;margin:2px 0}
.msg:hover{background:#2b2d31}
.head{font-size:13px;color:#949ba4}
.who{font-weight:600;color:#fff;font-size:15px}
.tag{background:#5865f2;color:#fff;border-radius:3px;font-size:10px;padding:1px 4px;margin-left:4px;vertical-align:middle}
.uid,.reply,.edited{font-size:12px}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
.unavailable,.system{color:#949ba4;font-style:italic}
.att,.sticker{margin:4px 0 0;padding:0;list-style:none;font-size:13px;color:#b5bac1}
.embed{margin:6px 0 0;border-left:4px solid #5865f2;background:#2b2d31;border-radius:0 4px 4px 0;padding:6px 10px;font-size:14px}
.embed b{color:#fff}
.embed .f{margin-top:4px}
.empty{color:#949ba4}
a{color:#00a8fc}
`.replace(/\n/g, '');

function renderMessage(r, textVisible) {
  const when = new Date(r.at);
  const validTime = !Number.isNaN(when.getTime());
  const author = r.author || {};
  const name = line(author.name || author.username || 'Unknown');
  const attachments = Array.isArray(r.attachments) ? r.attachments : [];
  const embeds = Array.isArray(r.embeds) ? r.embeds : [];
  const stickers = Array.isArray(r.stickers) ? r.stickers : [];
  const idAttr = String(r.id ?? '').replace(/\D/g, '');

  let html = `<div class="msg"${idAttr ? ` id="m${idAttr}"` : ''}><div class="head"><span class="who">${name}</span>`;
  if (author.bot) html += '<span class="tag">BOT</span>';
  if (author.id) html += ` <span class="uid">(${line(author.id)})</span>`;
  if (validTime) html += ` <time datetime="${esc(when.toISOString())}">${esc(utc(when))}</time>`;
  if (r.edited) html += ' <span class="edited">(edited)</span>';
  if (r.replyTo) html += ` <span class="reply">↪ reply to message ${line(r.replyTo)}</span>`;
  html += '</div>';

  const content = clean(r.content);
  if (r.system) html += `<div class="system">[system message: ${line(r.system)}]</div>`;
  if (content) html += `<div class="text">${esc(content)}</div>`;

  for (const e of embeds) {
    const parts = [];
    if (e.title) parts.push(`<b>${line(e.title)}</b>`);
    if (e.description) parts.push(`<div class="text">${text(e.description)}</div>`);
    for (const f of Array.isArray(e.fields) ? e.fields : []) parts.push(`<div class="f"><b>${line(f.name)}</b><div class="text">${text(f.value)}</div></div>`);
    if (e.footer) parts.push(`<div class="uid">${line(e.footer)}</div>`);
    if (parts.length) html += `<div class="embed">${parts.join('')}</div>`;
  }

  if (attachments.length) {
    html += '<ul class="att">';
    for (const a of attachments) {
      const href = safeUrl(a.url, { httpsOnly: true });
      const size = formatBytes(a.size);
      const bits = [`📎 ${line(a.name || 'file')}`, size, a.type ? line(a.type) : ''].filter(Boolean).join(' · ');
      html += `<li>${bits}${href ? ` · <a href="${esc(href)}" rel="noopener noreferrer nofollow" target="_blank">link (may expire)</a>` : ''}</li>`;
    }
    html += '</ul>';
  }
  for (const s of stickers) html += `<div class="sticker">Sticker: ${line(s)}</div>`;

  const hasBody = content || r.system || embeds.length || attachments.length || stickers.length;
  if (!hasBody && !textVisible && !author.bot) html += '<div class="unavailable">[content unavailable]</div>';
  return `${html}</div>`;
}

// ---- the plain-text copy ------------------------------------------------------------------------------------------------
const INDENT = '    ';
/** Message text, every non-blank line indented, with every kind of line break turned into \n. */
const block = (s) => clean(s).replace(/\r\n?|\u0085/g, '\n').split('\n').map((l) => (l.trim() ? INDENT + l : '')).join('\n');

function renderText(r, textVisible) {
  const when = new Date(r.at);
  const author = r.author || {};
  const attachments = Array.isArray(r.attachments) ? r.attachments : [];
  const embeds = Array.isArray(r.embeds) ? r.embeds : [];
  const stickers = Array.isArray(r.stickers) ? r.stickers : [];

  let head = `[${Number.isNaN(when.getTime()) ? 'unknown time' : utc(when)}] ${oneLine(author.name || author.username || 'Unknown')}`;
  if (author.bot) head += ' [BOT]';
  if (author.id) head += ` (${oneLine(author.id)})`;
  if (r.edited) head += ' (edited)';
  if (r.replyTo) head += ` - reply to message ${oneLine(r.replyTo)}`;

  const body = [];
  const content = clean(r.content);
  if (r.system) body.push(`${INDENT}[system message: ${oneLine(r.system)}]`);
  if (content) body.push(block(content));
  for (const e of embeds) {
    const lines = [];
    if (e.title) lines.push(`${INDENT}[embed] ${oneLine(e.title)}`);
    if (e.description) lines.push(block(e.description));
    for (const f of Array.isArray(e.fields) ? e.fields : []) lines.push(block(`${oneLine(f.name)}: ${clean(f.value)}`));
    if (e.footer) lines.push(`${INDENT}${oneLine(e.footer)}`);
    if (lines.length) body.push(lines.join('\n'));
  }
  for (const a of attachments) {
    const href = safeUrl(a.url, { httpsOnly: true });
    body.push(`${INDENT}Attachment: ${[oneLine(a.name || 'file'), formatBytes(a.size), a.type ? oneLine(a.type) : '', href ? `${href} (link may expire)` : ''].filter(Boolean).join(' | ')}`);
  }
  for (const s of stickers) body.push(`${INDENT}Sticker: ${oneLine(s)}`);

  const hasBody = content || r.system || embeds.length || attachments.length || stickers.length;
  if (!hasBody && !textVisible && !author.bot) body.push(`${INDENT}[content unavailable]`);
  return [head, ...body].join('\n');
}

function textShell({ guildName, channelName, channelId, generated, count, notes }) {
  const meta = [
    oneLine(guildName) ? `Server: ${oneLine(guildName)}` : '',
    `Channel: #${oneLine(channelName)}${channelId ? ` (${oneLine(channelId)})` : ''}`,
    `Saved ${utc(generated)}`,
    `${count} message${count === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' | ');
  return [`Transcript of #${oneLine(channelName) || 'channel'}`, meta, ...notes.map((n) => `NOTE: ${n}`), '='.repeat(60), '', ''].join('\n');
}

/** The parts of the document around the messages. `notes` lists the notices to show; `count` is the message count. */
function shell({ guildName, channelName, channelId, generated, count, notes }) {
  const title = `Transcript of #${oneLine(channelName) || 'channel'}`;
  const before = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`
    + `<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body><main>`
    + `<h1>${esc(title)}</h1>`
    + `<p class="meta">${line(guildName) ? `Server: ${line(guildName)} · ` : ''}Channel: #${line(channelName)}${channelId ? ` (${line(channelId)})` : ''} · Saved ${esc(utc(generated))} · ${esc(String(count))} message${count === 1 ? '' : 's'}</p>`
    + notes.map((n) => `<div class="notice">${esc(n)}</div>`).join('');
  const after = '</main></body></html>';
  return { before, after };
}

/**
 * @param {{guildName?: string, channelName?: string, channelId?: string, textVisible?: boolean, text?: boolean, maxBytes?: number,
 *          maxMessages?: number, now?: Date}} [opts]
 *   textVisible: false when the bot may not read other people's message text (no Message Content intent).
 *   text: also build a plain .txt copy of the same messages. `maxBytes` then covers both files together.
 * @returns {{add: (records: object[]) => boolean, finish: () => {buffer: Buffer, name: string, messages: number, bytes: number, truncated: boolean,
 *          reason: string, text: null | {buffer: Buffer, name: string, bytes: number}, totalBytes: number}}}
 *   `buffer`/`name`/`bytes` are the .html file; `text` is the .txt file (null unless asked for).
 */
export function createTranscript({ guildName = '', channelName = '', channelId = '', textVisible = true, text: withText = false, maxBytes = TRANSCRIPT_MAX_BYTES, maxMessages = Infinity, now = new Date() } = {}) {
  const NOTICE_TEXT = 'Message text is not included: the bot does not have the Message Content permission, so Discord hides what other people wrote. Only who wrote when (and the bot\'s own messages) is listed.';
  const noticeFor = (reason) => (reason === 'size'
    ? 'This transcript stops here: the file reached its size limit. Earlier messages are shown, later ones are missing.'
    : 'This transcript stops here: the message limit was reached. Earlier messages are shown, later ones are missing.');
  const base = { guildName, channelName, channelId, generated: now };
  // Reserve room for the document around the messages, measured with the longest notices, so the final file never exceeds maxBytes.
  const worst = shell({ ...base, count: 9999999999, notes: [NOTICE_TEXT, noticeFor('size')] });
  const worstText = withText ? textShell({ ...base, count: 9999999999, notes: [NOTICE_TEXT, noticeFor('size')] }) : '';
  const budget = maxBytes - Buffer.byteLength(worst.before) - Buffer.byteLength(worst.after) - Buffer.byteLength(worstText) - 128;

  const parts = [];
  const textParts = [];
  let used = 0;
  let count = 0;
  let stopped = false;
  let reason = '';

  return {
    add(records) {
      for (const r of records) {
        if (stopped) return false;
        if (count >= maxMessages) { stopped = true; reason = 'messages'; return false; }
        const html = renderMessage(r, textVisible);
        const plain = withText ? renderText(r, textVisible) : '';
        const size = Buffer.byteLength(html) + (withText ? Buffer.byteLength(plain) + 2 : 0); // + the blank line between messages
        if (used + size > budget) { stopped = true; reason = 'size'; return false; }
        parts.push(html);
        if (withText) textParts.push(plain);
        used += size;
        count += 1;
      }
      return !stopped;
    },
    finish() {
      const notes = [];
      if (!textVisible) notes.push(NOTICE_TEXT);
      if (stopped) notes.push(noticeFor(reason));
      const { before, after } = shell({ ...base, count, notes });
      const body = count ? parts.join('') : '<p class="empty">There are no messages in this channel.</p>';
      const buffer = Buffer.from(before + body + after, 'utf8');
      let text = null;
      if (withText) {
        const plain = Buffer.from(textShell({ ...base, count, notes }) + (count ? `${textParts.join('\n\n')}\n` : 'There are no messages in this channel.\n'), 'utf8');
        text = { buffer: plain, name: transcriptFileName(channelName, now, 'txt'), bytes: plain.length };
      }
      return { buffer, name: transcriptFileName(channelName, now), messages: count, bytes: buffer.length, truncated: stopped, reason, text, totalBytes: buffer.length + (text?.bytes ?? 0) };
    },
  };
}
