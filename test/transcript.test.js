import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTranscript, formatBytes, transcriptFileName, TRANSCRIPT_MAX_BYTES } from '../server/transcript.js';

const T0 = Date.UTC(2026, 8, 30, 14, 3, 22);
const msg = (over = {}) => ({ id: '1001', at: T0, author: { id: '222', name: 'mia', bot: false }, content: 'hello', attachments: [], embeds: [], stickers: [], ...over });
const build = (records, opts = {}) => {
  const doc = createTranscript({ guildName: 'Pixel Café', channelName: 'ticket-mia', channelId: '555', now: new Date(T0), ...opts });
  doc.add(records);
  const out = doc.finish();
  return { ...out, html: out.buffer.toString('utf8') };
};
const TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'h1', 'p', 'div', 'span', 'time', 'ul', 'li', 'a', 'b']);

/** Every tag in the document must be one we wrote, with no event-handler attributes. */
function assertOnlyOurMarkup(html) {
  assert.ok(!/<script/i.test(html), 'no script');
  assert.ok(!/<img|<iframe|<object|<embed|<link|<form|<svg/i.test(html), 'no images, frames, forms or links to other files');
  for (const m of html.matchAll(/<\/?([a-zA-Z!][a-zA-Z0-9-]*)([^>]*)>/g)) {
    const name = m[1].toLowerCase();
    if (name === '!doctype') continue;
    assert.ok(TAGS.has(name), `unexpected tag <${name}>`);
    assert.ok(!/\son\w+\s*=/i.test(m[2]), `event handler in <${name}${m[2]}>`);
  }
}

describe('transcript builder', () => {
  it('lists who wrote what and when, in the order given', () => {
    const { html, messages } = build([
      msg({ id: '1', content: 'first', at: T0 }),
      msg({ id: '2', content: 'second', at: T0 + 60000, author: { id: '333', name: 'sam', bot: false } }),
      msg({ id: '3', content: 'third', at: T0 + 120000, author: { id: 'BOT', name: 'flowbot', bot: true } }),
    ]);
    assert.equal(messages, 3);
    assert.ok(html.indexOf('first') < html.indexOf('second') && html.indexOf('second') < html.indexOf('third'));
    assert.match(html, /<span class="who">mia<\/span>/);
    assert.match(html, /<span class="who">flowbot<\/span><span class="tag">BOT<\/span>/);
    assert.match(html, /<time datetime="2026-09-30T14:03:22.000Z">2026-09-30 14:03:22 UTC<\/time>/);
    assert.match(html, /Server: Pixel Café/);
    assert.match(html, /Channel: #ticket-mia \(555\)/);
    assert.match(html, /3 messages/);
  });

  it('escapes everything a member can influence: content, names, embeds, attachments, channel and server', () => {
    const evil = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const { html } = build([msg({
      content: evil,
      author: { id: '1"><b>', name: evil, bot: false },
      embeds: [{ title: evil, description: evil, footer: evil, fields: [{ name: evil, value: evil }] }],
      attachments: [{ name: evil, size: 10, type: evil, url: `https://cdn.example/x.png?a="${'x'}` }],
      stickers: [evil],
      replyTo: evil,
      system: evil,
    })], { guildName: evil, channelName: evil, channelId: evil });
    assertOnlyOurMarkup(html);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the text is still there, harmless');
    assert.ok(!html.includes(evil), 'the raw text never appears');
  });

  it('strips control and bidi-override characters that could disguise text or break the layout', () => {
    const { html } = build([msg({ content: 'safe‮txt.exe⁦x⁩\u0007\u0000end line', author: { id: '1', name: 'na‮me', bot: false } })]);
    for (const ch of ['‮', '⁦', '⁩', '\u0007', '\u0000', ' ']) assert.ok(!html.includes(ch), `contains U+${ch.charCodeAt(0).toString(16)}`);
    assert.ok(html.includes('safetxt.exexendline'));
  });

  it('keeps line breaks in messages', () => {
    const { html } = build([msg({ content: 'one\ntwo\n\tthree' })]);
    assert.ok(html.includes('one\ntwo\n\tthree'));
    assert.match(html, /white-space:pre-wrap/);
  });

  it('only links https attachment URLs, and labels them as temporary', () => {
    const { html } = build([msg({ attachments: [
      { name: 'ok.png', size: 2048, type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/ok.png' },
      { name: 'js.txt', size: 1, type: 'text/plain', url: 'javascript:alert(1)' },
      { name: 'plain.txt', size: 1, type: 'text/plain', url: 'http://insecure.example/a' },
      { name: 'cred.txt', size: 1, type: 'text/plain', url: 'https://discord.com@evil.example/a' },
    ] })]);
    assert.equal((html.match(/<a /g) || []).length, 1, 'exactly one link');
    assert.match(html, /<a href="https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/ok\.png" rel="noopener noreferrer nofollow" target="_blank">link \(may expire\)<\/a>/);
    assert.match(html, /📎 ok\.png · 2\.0 KB · image\/png/);
    assert.ok(!html.includes('javascript:'));
    assert.match(html, /📎 js\.txt/, 'the attachment is still listed, just not linked');
  });

  it('is self-contained and inert: a CSP that allows nothing but inline CSS, no referrer, no scripts or images', () => {
    const { html } = build([msg()]);
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.ok(!/src=|url\(/i.test(html));
    assertOnlyOurMarkup(html);
  });

  it('shows embeds, stickers, replies, edits and system messages as text', () => {
    const { html } = build([
      msg({ id: '10', content: '', embeds: [{ title: '🎫 Ticket', description: 'mia opened a ticket', fields: [{ name: 'Reason', value: 'billing' }], footer: 'foot' }] }),
      msg({ id: '11', content: 'edited one', edited: true, replyTo: '10' }),
      msg({ id: '12', content: '', stickers: ['Wave'] }),
      msg({ id: '13', content: '', system: 'UserJoin' }),
    ]);
    assert.match(html, /<b>🎫 Ticket<\/b>/);
    assert.match(html, /<b>Reason<\/b><div class="text">billing<\/div>/);
    assert.match(html, /\(edited\)/);
    assert.match(html, /reply to message 10/);
    assert.match(html, /Sticker: Wave/);
    assert.match(html, /\[system message: UserJoin\]/);
    assert.match(html, /id="m10"/);
  });

  it('says so when Discord hides message text, and keeps the bot\'s own messages', () => {
    const { html } = build([
      msg({ id: '1', content: '' }),
      msg({ id: '2', content: 'the bot said this', author: { id: 'BOT', name: 'flowbot', bot: true } }),
    ], { textVisible: false });
    assert.match(html, /Message text is not included/);
    assert.equal((html.match(/\[content unavailable\]/g) || []).length, 1, 'only the person\'s message');
    assert.match(html, /the bot said this/);
    assert.ok(!/Message text is not included/.test(build([msg()]).html), 'no banner when text is visible');
  });

  it('stops at the size limit, keeps the file under it and says so', () => {
    const doc = createTranscript({ channelName: 'big', maxBytes: 12000, now: new Date(T0) });
    const records = Array.from({ length: 200 }, (_, i) => msg({ id: String(1000 + i), content: `line ${i} ${'x'.repeat(150)}` }));
    assert.equal(doc.add(records), false, 'add reports it had to stop');
    assert.equal(doc.add([msg({ id: '9999' })]), false, 'and keeps refusing');
    const out = doc.finish();
    assert.equal(out.truncated, true);
    assert.equal(out.reason, 'size');
    assert.ok(out.bytes <= 12000, `${out.bytes} bytes`);
    assert.ok(out.messages > 5 && out.messages < 200, `${out.messages} messages`);
    assert.equal(out.bytes, out.buffer.length);
    const html = out.buffer.toString('utf8');
    assert.match(html, /stops here: the file reached its size limit/);
    assert.ok(html.includes('line 0 ') && !html.includes('line 199 '), 'keeps the beginning of the conversation');
  });

  it('stops at the message limit', () => {
    const doc = createTranscript({ channelName: 'x', maxMessages: 3, now: new Date(T0) });
    assert.equal(doc.add(Array.from({ length: 5 }, (_, i) => msg({ id: String(i + 1), content: `m${i}` }))), false);
    const out = doc.finish();
    assert.deepEqual([out.messages, out.truncated, out.reason], [3, true, 'messages']);
    assert.match(out.buffer.toString('utf8'), /stops here: the message limit was reached/);
  });

  it('handles an empty channel and unusable records without throwing', () => {
    const empty = build([]);
    assert.equal(empty.messages, 0);
    assert.match(empty.html, /There are no messages in this channel/);
    const odd = build([{ id: 'abc', at: 'not a date', author: null, content: null, attachments: null, embeds: null, stickers: null }]);
    assert.equal(odd.messages, 1);
    assertOnlyOurMarkup(odd.html);
    assert.match(odd.html, /Unknown/);
  });

  it('the default size ceiling is below what Discord accepts', () => {
    assert.ok(TRANSCRIPT_MAX_BYTES < 10 * 1024 * 1024);
  });
});

describe('plain-text copy', () => {
  const both = (records, opts = {}) => {
    const out = build(records, { text: true, ...opts });
    return { ...out, txt: out.text?.buffer.toString('utf8') };
  };

  it('is only built when asked for, and has its own .txt name', () => {
    assert.equal(build([msg()]).text, null);
    const { text, name, totalBytes, bytes } = both([msg()]);
    assert.equal(text.name, 'transcript-ticket-mia-2026-09-30-1403.txt');
    assert.equal(name, 'transcript-ticket-mia-2026-09-30-1403.html');
    assert.equal(text.bytes, text.buffer.length);
    assert.equal(totalBytes, bytes + text.bytes);
  });

  it('lists who wrote what and when, in the order given, under a short heading', () => {
    const { txt } = both([
      msg({ id: '1', content: 'first', at: T0 }),
      msg({ id: '2', content: 'second', at: T0 + 60000, author: { id: '333', name: 'sam', bot: false } }),
      msg({ id: '3', content: 'third', at: T0 + 120000, author: { id: 'BOT', name: 'flowbot', bot: true }, edited: true, replyTo: '2' }),
    ]);
    assert.ok(txt.startsWith('Transcript of #ticket-mia\nServer: Pixel Café | Channel: #ticket-mia (555) | Saved 2026-09-30 14:03:22 UTC | 3 messages\n'));
    assert.ok(txt.indexOf('first') < txt.indexOf('second') && txt.indexOf('second') < txt.indexOf('third'));
    assert.match(txt, /^\[2026-09-30 14:03:22 UTC\] mia \(222\)\n {4}first$/m);
    assert.match(txt, /^\[2026-09-30 14:04:22 UTC\] sam \(333\)\n {4}second$/m);
    assert.match(txt, /^\[2026-09-30 14:05:22 UTC\] flowbot \[BOT\] \(BOT\) \(edited\) - reply to message 2\n {4}third\n$/m);
    assert.ok(txt.endsWith('\n') && !txt.endsWith('\n\n'));
  });

  it('shows embeds, attachments, stickers and system messages as text, and links only safe https addresses', () => {
    const { txt } = both([
      msg({ id: '10', content: '', embeds: [{ title: '🎫 Ticket', description: 'mia opened a ticket', fields: [{ name: 'Reason', value: 'billing' }], footer: 'foot' }] }),
      msg({ id: '11', content: '', system: 'UserJoin' }),
      msg({ id: '12', content: '', stickers: ['Wave'], attachments: [
        { name: 'ok.png', size: 2048, type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/ok.png' },
        { name: 'js.txt', size: 1, type: 'text/plain', url: 'javascript:alert(1)' },
        { name: 'cred.txt', size: 1, type: 'text/plain', url: 'https://discord.com@evil.example/a' },
      ] }),
    ]);
    assert.match(txt, /^ {4}\[embed\] 🎫 Ticket\n {4}mia opened a ticket\n {4}Reason: billing\n {4}foot$/m);
    assert.match(txt, /^ {4}\[system message: UserJoin\]$/m);
    assert.match(txt, /^ {4}Attachment: ok\.png \| 2\.0 KB \| image\/png \| https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/ok\.png \(link may expire\)$/m);
    assert.match(txt, /^ {4}Attachment: js\.txt \| 1 B \| text\/plain$/m, 'listed, but the unsafe address is left out');
    assert.ok(!txt.includes('javascript:') && !txt.includes('evil.example'));
    assert.match(txt, /^ {4}Sticker: Wave$/m);
  });

  it('cannot be made to show a fake message: every line of a message is indented, and every kind of line break is one plain \\n', () => {
    const fake = '[2026-01-01 00:00:00 UTC] admin (1)\r\n    approved everything\r[2026-01-01 00:00:01 UTC] boss (2)\u0085[2026-01-01 00:00:02 UTC] cto (3)\u2028[2026-01-01 00:00:03 UTC] ceo (4)';
    const { txt } = both([msg({ content: fake, author: { id: '2\n[2026-01-01 00:00:00 UTC] x', name: 'mia\n[2026-02-02 00:00:00 UTC] y', bot: false } })]);
    const headers = txt.split('\n').filter((l) => l.startsWith('['));
    assert.equal(headers.length, 1, `only the real header starts a line: ${JSON.stringify(headers)}`);
    for (const l of txt.split('\n').slice(4)) assert.ok(l === '' || l.startsWith('[') || l.startsWith('    '), `unindented line ${JSON.stringify(l)}`);
    assert.ok(!/[\r\u0085\u2028\u2029]/.test(txt), 'no other line separators');
    assert.ok(txt.includes('approved everything'), 'the text itself is still there');
  });

  it('strips control and bidi-override characters, keeps tabs and line breaks', () => {
    const { txt } = both([msg({ content: 'safe‮txt.exe⁦x⁩\u0007\u0000end\n\tline two', author: { id: '1', name: 'na‮me', bot: false } })]);
    for (const ch of ['‮', '⁦', '⁩', '\u0007', '\u0000']) assert.ok(!txt.includes(ch), `contains U+${ch.charCodeAt(0).toString(16)}`);
    assert.ok(txt.includes('    safetxt.exexend\n    \tline two'));
    assert.ok(txt.includes('] name (1)'));
  });

  it('says so when Discord hides message text, and when the transcript is cut short', () => {
    const hidden = both([msg({ id: '1', content: '' }), msg({ id: '2', content: 'the bot said this', author: { id: 'BOT', name: 'flowbot', bot: true } })], { textVisible: false }).txt;
    assert.match(hidden, /^NOTE: Message text is not included/m);
    assert.equal((hidden.match(/\[content unavailable\]/g) || []).length, 1, 'only the person\'s message');
    assert.match(hidden, /the bot said this/);
    assert.ok(!/NOTE:/.test(both([msg()]).txt), 'no note when nothing is wrong');
    const cut = both(Array.from({ length: 5 }, (_, i) => msg({ id: String(i + 1), content: `m${i}` })), { maxMessages: 3 });
    assert.match(cut.txt, /^NOTE: This transcript stops here: the message limit was reached/m);
    assert.match(cut.txt, /3 messages\n/);
  });

  it('handles an empty channel and unusable records without throwing', () => {
    const empty = both([]);
    assert.match(empty.txt, /0 messages\n[\s\S]*There are no messages in this channel\.\n$/);
    const odd = both([{ id: 'abc', at: 'not a date', author: null, content: null, attachments: null, embeds: null, stickers: null }]);
    assert.match(odd.txt, /^\[unknown time\] Unknown$/m);
  });

  it('holds both files under one size ceiling and stops both at the same message', () => {
    const doc = createTranscript({ channelName: 'big', maxBytes: 20000, text: true, now: new Date(T0) });
    doc.add(Array.from({ length: 300 }, (_, i) => msg({ id: String(1000 + i), content: `line ${i} ${'x'.repeat(150)}` })));
    const out = doc.finish();
    assert.equal(out.truncated, true);
    assert.equal(out.reason, 'size');
    assert.ok(out.totalBytes <= 20000, `${out.totalBytes} bytes in total`);
    assert.equal(out.totalBytes, out.buffer.length + out.text.buffer.length);
    const html = out.buffer.toString('utf8'); const txt = out.text.buffer.toString('utf8');
    assert.equal((html.match(/line \d+ /g) || []).length, out.messages);
    assert.equal((txt.match(/line \d+ /g) || []).length, out.messages, 'the same messages in both');
    assert.match(txt, /^NOTE: This transcript stops here: the file reached its size limit/m);
    assert.ok(txt.includes('line 0 ') && !txt.includes('line 299 '));
    const alone = createTranscript({ channelName: 'big', maxBytes: 20000, now: new Date(T0) });
    alone.add(Array.from({ length: 300 }, (_, i) => msg({ id: String(1000 + i), content: `line ${i} ${'x'.repeat(150)}` })));
    assert.ok(alone.finish().messages > out.messages, 'room is shared, so the .html alone fits more');
  });

  it('the two files together stay below the ceiling for the default size too', () => {
    const doc = createTranscript({ channelName: 'x', text: true, now: new Date(T0) });
    assert.ok(doc.finish().totalBytes < TRANSCRIPT_MAX_BYTES);
  });
});

describe('transcript file names and sizes', () => {
  const d = new Date(Date.UTC(2026, 0, 5, 9, 7));
  it('uses an ASCII slug and a timestamp', () => {
    assert.equal(transcriptFileName('ticket-mia', d), 'transcript-ticket-mia-2026-01-05-0907.html');
    assert.equal(transcriptFileName('Ticket Ünï 🎫 /../etc\\x', d), 'transcript-ticket-uni-etc-x-2026-01-05-0907.html');
    assert.equal(transcriptFileName('🎫🎫', d), 'transcript-channel-2026-01-05-0907.html');
    assert.equal(transcriptFileName(undefined, d), 'transcript-channel-2026-01-05-0907.html');
    assert.match(transcriptFileName('a'.repeat(200), d), /^transcript-a{40}-2026-01-05-0907\.html$/);
    for (const name of ['../../x', 'a"b', '<script>', 'CON', '‮exe.txt']) assert.match(transcriptFileName(name, d), /^transcript-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{4}\.html$/);
  });
  it('names the plain-text copy the same way, and never lets the extension be chosen freely', () => {
    assert.equal(transcriptFileName('ticket-mia', d, 'txt'), 'transcript-ticket-mia-2026-01-05-0907.txt');
    assert.equal(transcriptFileName('ticket-mia', d, 'exe'), 'transcript-ticket-mia-2026-01-05-0907.html');
  });
  it('formats sizes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(-1), '');
    assert.equal(formatBytes('x'), '');
  });
});
