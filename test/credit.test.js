// The credit line: on public pages and saved transcript pages, once, and never as markup.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newBlock, normalizePage } from '../shared/blocks.js';
import { CREDIT } from '../shared/credit.js';
import { renderPage } from '../shared/render-page.js';
import { createTranscript } from '../server/transcript.js';

const count = (s, needle) => s.split(needle).length - 1;

describe('the credit line', () => {
  it('says who made it', () => assert.equal(CREDIT, 'made by itsmemusicchilly'));

  it('ends every public page, once, after the admins\' own line', () => {
    const page = normalizePage({ slug: 'hello', title: 'Hello', blocks: [newBlock('text')] });
    const html = renderPage({ page, guild: { id: '111111', name: 'Pixel Café' } });
    assert.equal(count(html, CREDIT), 1);
    assert.match(html, /<footer class="site-foot">This page was made by the admins of Pixel Café\..*<br>made by itsmemusicchilly<\/footer>/s);
  });

  it('ends every saved transcript page, once, inside the page and as plain escaped text', () => {
    const doc = createTranscript({ guildName: 'Pixel Café', channelName: 'ticket-mia', channelId: '555', now: new Date(0) });
    doc.add([{ id: '1', at: 0, author: { id: '2', name: 'mia', bot: false }, content: 'hello', attachments: [], embeds: [], stickers: [] }]);
    const html = doc.finish().buffer.toString('utf8');
    assert.equal(count(html, CREDIT), 1);
    assert.match(html, /<p class="credit">made by itsmemusicchilly<\/p><\/main><\/body><\/html>$/);
  });

  it('is part of the size budget: a transcript that hits the limit still fits it, credit included', () => {
    const max = 6000;
    const doc = createTranscript({ channelName: 'c', maxBytes: max });
    for (let i = 0; i < 200; i += 1) doc.add([{ id: String(i + 1), at: i, author: { id: '2', name: 'mia', bot: false }, content: 'x'.repeat(100), attachments: [], embeds: [], stickers: [] }]);
    const out = doc.finish();
    assert.ok(out.truncated);
    assert.ok(out.buffer.length <= max, `${out.buffer.length} > ${max}`);
    assert.ok(out.buffer.toString('utf8').includes(CREDIT));
  });
});
