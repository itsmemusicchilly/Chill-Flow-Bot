// Reading feeds: what real sites send (YouTube, Reddit, Bluesky, Mastodon, GitHub, blogs) and what a hostile one might.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FeedError, MAX_ITEMS, decodeEntities, htmlToText, parseFeed, parseXml } from '../server/feeds/parse.js';

const YOUTUBE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"/>
 <id>yt:channel:abcdefghijklmnopqrstuv</id>
 <yt:channelId>abcdefghijklmnopqrstuv</yt:channelId>
 <title>Pixel Café Live</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
 <author><name>Pixel Café Live</name><uri>https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv</uri></author>
 <published>2020-01-01T10:00:00+00:00</published>
 <entry>
  <id>yt:video:dQw4w9WgXcQ</id>
  <yt:videoId>dQw4w9WgXcQ</yt:videoId>
  <title>Big &amp; Bold: episode 12</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
  <author><name>Pixel Café Live</name><uri>https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv</uri></author>
  <published>2026-09-29T15:00:00+00:00</published>
  <updated>2026-09-29T16:00:00+00:00</updated>
  <media:group>
   <media:title>Big &amp; Bold: episode 12</media:title>
   <media:content url="https://www.youtube.com/v/dQw4w9WgXcQ?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i4.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480" height="360"/>
   <media:description>We talk about &lt;b&gt;everything&lt;/b&gt;.
Second line</media:description>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:older123</id>
  <title>An older one</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=older123"/>
  <published>2026-09-01T10:00:00+00:00</published>
 </entry>
</feed>`;

const REDDIT = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<title>newest submissions : gaming</title>
<entry>
 <author><name>/u/somebody</name><uri>https://www.reddit.com/user/somebody</uri></author>
 <category term="gaming" label="r/gaming"/>
 <content type="html">&lt;table&gt; &lt;tr&gt;&lt;td&gt; &lt;a href="https://www.reddit.com/r/gaming/comments/abc/x/"&gt; &lt;img src="https://preview.redd.it/x.jpg?width=640&amp;amp;s=1" alt="t" /&gt; &lt;/a&gt; &lt;/td&gt;&lt;td&gt; &amp;#32; submitted by &amp;#32; &lt;a href="https://www.reddit.com/user/somebody"&gt; /u/somebody &lt;/a&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>
 <id>t3_abc</id>
 <link href="https://www.reddit.com/r/gaming/comments/abc/x/"/>
 <updated>2026-09-29T12:00:00+00:00</updated>
 <title>My new setup</title>
</entry>
</feed>`;

const BLUESKY = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Alice (@alice.bsky.social)</title><link>https://bsky.app/profile/alice.bsky.social</link><description>bio</description>
<item><link>https://bsky.app/profile/alice.bsky.social/post/3kabc</link><guid isPermaLink="true">https://bsky.app/profile/alice.bsky.social/post/3kabc</guid><pubDate>Tue, 29 Sep 2026 15:00:00 GMT</pubDate><description>Hello world! First post.</description></item>
</channel></rss>`;

const MASTODON = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:webfeeds="http://webfeeds.org/rss/1.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Sam</title><link>https://mastodon.example/@sam</link>
<item><guid isPermaLink="true">https://mastodon.example/@sam/111</guid><link>https://mastodon.example/@sam/111</link><pubDate>Tue, 29 Sep 2026 09:30:00 +0000</pubDate>
<description>&lt;p&gt;Fresh &lt;a href="https://mastodon.example/tags/art"&gt;#art&lt;/a&gt; &amp;amp; coffee&lt;/p&gt;</description>
<media:content url="https://files.example/cat.png" type="image/png" medium="image"><media:rating>nonadult</media:rating></media:content></item>
</channel></rss>`;

const GITHUB = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
<id>tag:github.com,2008:https://github.com/x/y/releases</id><title>Release notes from y</title>
<entry><id>tag:github.com,2008:Repository/1/v1.2.0</id><updated>2026-09-28T10:00:00Z</updated>
<link rel="alternate" type="text/html" href="https://github.com/x/y/releases/tag/v1.2.0"/><title>v1.2.0</title>
<content type="html">&lt;p&gt;Fixes:&lt;/p&gt;&lt;ul&gt;&lt;li&gt;one&lt;/li&gt;&lt;li&gt;two&lt;/li&gt;&lt;/ul&gt;</content>
<author><name>octocat</name></author><media:thumbnail height="30" width="30" url="https://avatars.githubusercontent.com/u/1?s=60&amp;v=4"/></entry></feed>`;

const BLOG = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>My Blog</title>
<item><title><![CDATA[I <3 pizza & x > y]]></title><link>https://blog.example/hello/</link><dc:creator><![CDATA[Sam]]></dc:creator><pubDate>Tue, 30 Sep 2026 08:00:00 +0000</pubDate>
<guid isPermaLink="false">https://blog.example/?p=12</guid><description><![CDATA[<p>Short</p>]]></description>
<content:encoded><![CDATA[<p>Long <img src="https://blog.example/i.png"> text</p>]]></content:encoded></item></channel></rss>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://old.example/"><title>Old school</title></channel>
<item rdf:about="https://old.example/1"><title>Item one</title><link>https://old.example/1</link><dc:date>2026-09-27T10:00:00Z</dc:date><description>First</description></item></rdf:RDF>`;

const JSONFEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1', title: 'JSON blog',
  items: [{ id: 42, url: 'https://json.example/42', title: 'Numbered', content_html: '<p>Hi <b>there</b></p>', date_published: '2026-09-26T10:00:00Z', authors: [{ name: 'Jo' }], image: 'https://json.example/i.png' }],
});

describe('real feeds', () => {
  it('YouTube (Atom): the video, its link, thumbnail, description and time; the channel name as the feed title', () => {
    const feed = parseFeed(YOUTUBE);
    assert.equal(feed.title, 'Pixel Café Live');
    assert.equal(feed.items.length, 2);
    assert.deepEqual(feed.items[0], {
      id: 'yt:video:dQw4w9WgXcQ', title: 'Big & Bold: episode 12', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', author: 'Pixel Café Live',
      published: '2026-09-29T15:00:00.000Z', summary: 'We talk about everything.\nSecond line', image: 'https://i4.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });
    assert.deepEqual([feed.items[1].id, feed.items[1].title, feed.items[1].image, feed.items[1].summary], ['yt:video:older123', 'An older one', '', '']);
  });

  it('Reddit (Atom with HTML content): title, author, link, picture found inside the HTML, tidy text', () => {
    const [item] = parseFeed(REDDIT).items;
    assert.equal(item.id, 't3_abc');
    assert.equal(item.title, 'My new setup');
    assert.equal(item.author, '/u/somebody');
    assert.equal(item.link, 'https://www.reddit.com/r/gaming/comments/abc/x/');
    assert.equal(item.published, '2026-09-29T12:00:00.000Z', 'updated stands in when there is no published');
    assert.equal(item.image, 'https://preview.redd.it/x.jpg?width=640&s=1');
    assert.match(item.summary, /submitted by/);
    assert.ok(!/[<>]/.test(item.summary));
  });

  it('Bluesky (RSS 2.0): posts have no title, only text', () => {
    const feed = parseFeed(BLUESKY);
    assert.equal(feed.title, 'Alice (@alice.bsky.social)');
    assert.deepEqual(feed.items[0], {
      id: 'https://bsky.app/profile/alice.bsky.social/post/3kabc', title: '', link: 'https://bsky.app/profile/alice.bsky.social/post/3kabc', author: '',
      published: '2026-09-29T15:00:00.000Z', summary: 'Hello world! First post.', image: '',
    });
  });

  it('Mastodon (RSS 2.0 with media): the post text without its markup, and the attached picture', () => {
    const [item] = parseFeed(MASTODON).items;
    assert.equal(item.summary, 'Fresh #art & coffee');
    assert.equal(item.image, 'https://files.example/cat.png');
    assert.equal(item.published, '2026-09-29T09:30:00.000Z');
  });

  it('GitHub releases (Atom): version as title, notes as text, the author, an avatar with & in its address', () => {
    const [item] = parseFeed(GITHUB).items;
    assert.equal(item.title, 'v1.2.0');
    assert.equal(item.link, 'https://github.com/x/y/releases/tag/v1.2.0');
    assert.equal(item.author, 'octocat');
    assert.equal(item.summary, 'Fixes:\none\ntwo');
    assert.equal(item.image, 'https://avatars.githubusercontent.com/u/1?s=60&v=4');
  });

  it('a blog (RSS 2.0, CDATA, content:encoded): the title stays exactly as written; the picture comes from the body', () => {
    const [item] = parseFeed(BLOG).items;
    assert.equal(item.title, 'I <3 pizza & x > y', 'plain text is not mistaken for markup');
    assert.equal(item.author, 'Sam');
    assert.equal(item.id, 'https://blog.example/?p=12');
    assert.equal(item.summary, 'Long text', 'the full text is preferred over the short one');
    assert.equal(item.image, 'https://blog.example/i.png');
  });

  it('RSS 1.0 (RDF)', () => {
    const feed = parseFeed(RDF);
    assert.equal(feed.title, 'Old school');
    assert.deepEqual([feed.items[0].title, feed.items[0].published, feed.items[0].summary], ['Item one', '2026-09-27T10:00:00.000Z', 'First']);
  });

  it('JSON Feed', () => {
    const feed = parseFeed(JSONFEED);
    assert.equal(feed.title, 'JSON blog');
    assert.deepEqual(feed.items[0], { id: '42', title: 'Numbered', link: 'https://json.example/42', author: 'Jo', published: '2026-09-26T10:00:00.000Z', summary: 'Hi there', image: 'https://json.example/i.png' });
  });

  it('a leading byte-order mark and leading whitespace do not matter', () => {
    assert.equal(parseFeed(`﻿\n  ${BLUESKY}`).items.length, 1);
  });
});

describe('items with things missing', () => {
  it('an item without an id uses its link, or a fingerprint of its title and date; an item with nothing at all is dropped', () => {
    const feed = parseFeed('<rss><channel><item><title>A</title><link>https://x.example/a</link></item><item><title>B</title><pubDate>Tue, 29 Sep 2026 09:30:00 +0000</pubDate></item><item></item><item><title>B</title><pubDate>Tue, 29 Sep 2026 09:30:00 +0000</pubDate></item></channel></rss>');
    assert.equal(feed.items.length, 3);
    assert.equal(feed.items[0].id, 'https://x.example/a');
    assert.match(feed.items[1].id, /^[0-9a-f]{24}$/);
    assert.equal(feed.items[1].id, feed.items[2].id, 'the same title and date always give the same id');
  });

  it('bad dates and links are left blank rather than guessed', () => {
    const [item] = parseFeed('<rss><channel><item><guid>1</guid><title>T</title><link>javascript:alert(1)</link><pubDate>last tuesday</pubDate></item></channel></rss>').items;
    assert.deepEqual([item.link, item.published], ['', '']);
    const [b] = parseFeed('<rss><channel><item><guid>2</guid><link>ftp://x.example/f</link></item></channel></rss>').items;
    assert.equal(b.link, '');
  });

  it('only https pictures are kept, and only http(s) links', () => {
    const [item] = parseFeed('<rss xmlns:media="m"><channel><item><guid>1</guid><link>http://x.example/plain</link><media:thumbnail url="http://x.example/i.png"/></item></channel></rss>').items;
    assert.equal(item.link, 'http://x.example/plain');
    assert.equal(item.image, '');
  });

  it('long text is cut, control characters removed', () => {
    const [item] = parseFeed(`<rss><channel><item><guid>1</guid><title>${'t'.repeat(400)}</title><description>${'d'.repeat(900)}</description></item></channel></rss>`).items;
    assert.equal(item.title.length, 256);
    assert.equal(item.summary.length, 500);
    assert.ok(item.title.endsWith('…') && item.summary.endsWith('…'));
    const [c] = parseFeed(`<rss><channel><item><guid>1</guid><title>a&#7;b&#x1B;c${String.fromCharCode(0)}d${String.fromCharCode(0x202e)}e</title></item></channel></rss>`).items;
    assert.equal(c.title, 'abcde');
  });

  it('keeps at most 100 items', () => {
    const many = `<rss><channel>${Array.from({ length: 250 }, (_, i) => `<item><guid>${i}</guid><title>t${i}</title></item>`).join('')}</channel></rss>`;
    assert.equal(parseFeed(many).items.length, MAX_ITEMS);
    assert.equal(parseFeed(many).items[0].id, '0');
  });
});

describe('what is not a feed', () => {
  it('says what it got instead', () => {
    assert.throws(() => parseFeed(''), /answered with nothing/);
    assert.throws(() => parseFeed('   \n'), /answered with nothing/);
    assert.throws(() => parseFeed('<!DOCTYPE html><html><body>Hi</body></html>'), (e) => e instanceof FeedError && /web page, not a feed/.test(e.message));
    assert.throws(() => parseFeed('<html lang="en"><head></head></html>'), /web page, not a feed/);
    assert.throws(() => parseFeed('<?xml version="1.0"?><svg xmlns="x"/>'), /not an RSS, Atom or JSON feed/);
    assert.throws(() => parseFeed('just some words'), /not an RSS, Atom or JSON feed/);
    assert.throws(() => parseFeed('{"a": 1}'), /not a feed \(it has no “items”\)/);
    assert.throws(() => parseFeed('{broken json'), /could not be read/);
  });

  it('a feed with no items is fine', () => {
    assert.deepEqual(parseFeed('<rss><channel><title>Empty</title></channel></rss>'), { title: 'Empty', items: [] });
    assert.deepEqual(parseFeed('{"title":"e","items":[]}'), { title: 'e', items: [] });
  });
});

describe('hostile XML is inert', () => {
  it('a DOCTYPE with entities is skipped and its entities are never expanded (billion laughs)', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>
<rss><channel><item><guid>1</guid><title>&lol3;</title><description>&lol3;</description></item></channel></rss>`;
    const started = Date.now();
    const [item] = parseFeed(bomb).items;
    assert.ok(Date.now() - started < 500);
    assert.equal(item.title, '&lol3;', 'left exactly as written');
    assert.ok(item.summary.length < 20);
  });

  it('an external entity (XXE) reads nothing', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY secret SYSTEM "file:///etc/passwd"><!ENTITY net SYSTEM "https://169.254.169.254/latest/meta-data/">]>
<rss><channel><item><guid>1</guid><title>&secret;</title><description>&net;</description></item></channel></rss>`;
    const [item] = parseFeed(xxe).items;
    assert.equal(item.title, '&secret;');
    assert.ok(!/root:|meta-data|ami-/.test(JSON.stringify(item)));
  });

  it('a DOCTYPE with a ] and > inside its brackets does not end early or leak', () => {
    const [item] = parseFeed('<!DOCTYPE x [<!ENTITY a "]>"><!-- ]> -->]><rss><channel><item><guid>ok</guid><title>fine</title></item></channel></rss>').items;
    assert.equal(item.title, 'fine');
  });

  it('nesting that is too deep and documents with too many elements are refused, quickly', () => {
    const started = Date.now();
    assert.throws(() => parseFeed(`<rss>${'<a>'.repeat(200)}${'</a>'.repeat(200)}</rss>`), /nested too deeply/);
    assert.throws(() => parseFeed(`<rss><channel>${'<x/>'.repeat(100_001)}</channel></rss>`), /too many elements/);
    assert.ok(Date.now() - started < 2000);
  });

  it('a huge attribute list, unterminated tags and quotes, and stray < > cannot hang or crash it', () => {
    const started = Date.now();
    const attrs = Array.from({ length: 5000 }, (_, i) => `a${i}="v"`).join(' ');
    assert.doesNotThrow(() => parseFeed(`<rss ${attrs}><channel><item><guid>1</guid></item></channel></rss>`));
    for (const junk of ['<rss><channel><item', '<rss><channel><item a="unterminated', '<rss><channel><![CDATA[never closed', '<rss><!-- never closed', '<rss><channel><item><title>a < b > c</title><guid>1</guid></item></channel></rss>', '<<<<>>>>', '<rss></></></rss>']) {
      try { parseFeed(junk); } catch (e) { assert.ok(e instanceof FeedError, `${junk.slice(0, 30)} → ${e?.message}`); }
    }
    assert.ok(Date.now() - started < 2000);
  });

  it('script and style in a description never become text, and markup cannot smuggle a link in', () => {
    const [item] = parseFeed('<rss><channel><item><guid>1</guid><description>&lt;script&gt;alert(1)&lt;/script&gt;&lt;style&gt;p{}&lt;/style&gt;Hello &lt;a href="javascript:alert(2)"&gt;click&lt;/a&gt;</description></item></channel></rss>').items;
    assert.equal(item.summary, 'Hello click');
  });
});

describe('small helpers', () => {
  it('decodes the built-in and numeric entities and nothing else', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42;'), 'a & b <c> "d" \'e\' AB');
    assert.equal(decodeEntities('&nbsp; &custom;'), '&nbsp; &custom;', 'a named entity we do not know stays as written');
    assert.equal(decodeEntities('a&#0;b&#xD800;c&#1114112;d&#7;e&#x1B;f'), 'abcdef', 'a numeric reference to something that is not a real character is dropped');
    assert.equal(decodeEntities('&constructor; &__proto__; &toString;'), '&constructor; &__proto__; &toString;');
  });

  it('turns HTML into readable text', () => {
    assert.equal(htmlToText('<p>One</p><p>Two<br>three</p>'), 'One\nTwo\nthree');
    assert.equal(htmlToText('a&nbsp;b &hellip; &copy;'), 'a b … ©');
    assert.equal(htmlToText('<ul><li>x</li><li>y</li></ul>'), 'x\ny');
    assert.equal(htmlToText(null), '');
  });

  it('parseXml gives a plain tree', () => {
    const root = parseXml('<a x="1" y=\'2\'><b>hi</b><c/></a>');
    const a = root.children[0];
    assert.deepEqual([a.name, a.attrs, a.children.map((c) => c.name), a.children[0].text], ['a', { x: '1', y: '2' }, ['b', 'c'], 'hi']);
  });
});
