// Turns a page (structured data) into a complete HTML document. Used by the server for public pages and by the editor for
// its live preview, so what you see is exactly what visitors get.
//
// Security model: this file is the only place page content becomes HTML. Every value is escaped; URLs pass through
// safeUrl() or assetSrc() (an https link, or the same-origin path of a picture uploaded to this server); there is no script,
// no inline event handler and no CSS url(). The server also sends a CSP that forbids script.
import { BLOCK_TYPES, THEME_DEFAULTS } from './blocks.js';
import { parseOptions } from './forms.js';
import { pageMeta } from './page-meta.js';
import { assetSrc, safeUrl } from './urls.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const REL = 'noopener noreferrer nofollow ugc';

/** Inline formatting only: **bold**, *italic*, [text](https://link). Escapes first, so markup in the source stays text. */
export function renderInline(src) {
  const anchors = [];
  let s = esc(String(src ?? '').replace(CONTROL, ''));
  s = s.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g, (whole, label, url) => {
    const href = safeUrl(url.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    if (!href) return whole;
    anchors.push(`<a href="${esc(href)}" target="_blank" rel="${REL}">${label}</a>`);
    return `\u0001${anchors.length - 1}\u0001`;
  });
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => anchors[Number(i)]);
}

export function renderMarkdown(src) {
  const paragraphs = String(src ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.map((p) => `<p>${renderInline(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function onAccent(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
}

const CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:var(--w);margin:0 auto;padding:24px 20px 48px}
.brand{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:14px;margin-bottom:18px}
.brand img,.ico{width:28px;height:28px;border-radius:8px}.ico{display:grid;place-items:center;background:var(--accent);color:var(--on);font-weight:700}
h1,h2,h3{line-height:1.2;margin:1.2em 0 .5em}p{margin:.6em 0}a{color:var(--accent)}.center{text-align:center}
.hero{position:relative;overflow:hidden;border-radius:16px;padding:56px 24px;margin:8px 0 20px;background:var(--card);border:1px solid var(--line)}
.hero-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.35;border-radius:0}
.hero>*:not(.hero-bg){position:relative}.hero h1{font-size:clamp(28px,6vw,44px);margin:0 0 .3em}.hero .sub{color:var(--muted);font-size:1.15em}
.btn{display:inline-block;padding:10px 20px;border-radius:10px;border:2px solid var(--accent);background:var(--accent);color:var(--on);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.outline{background:transparent;color:var(--accent)}.btn-row{margin:1em 0}
figure{margin:1em 0}figure.center{margin-left:auto;margin-right:auto}img{max-width:100%;height:auto;border-radius:12px}
figure.medium{max-width:70%}figure.small{max-width:40%}figcaption{color:var(--muted);font-size:14px;margin-top:6px}
.list{padding-left:1.4em}.list.checks{list-style:none;padding-left:0}.list.checks li::before{content:"\\2713  ";color:var(--accent);font-weight:700}
hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}.spacer.s{height:12px}.spacer.m{height:32px}.spacer.l{height:72px}
.form{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;margin:1.2em 0}.form h2{margin-top:0}
.q{margin:1em 0}.q>label,.q>.lbl{display:block;font-weight:600;margin-bottom:6px}.req{color:#ff6b6b}
.q input[type=text],.q input[type=number],.q input[type=date],.q select,.q textarea{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
.q .opt{display:flex;gap:8px;align-items:flex-start;margin:4px 0}.q .help{color:var(--muted);font-size:14px;margin-top:4px}
.err{color:#ff6b6b;font-size:14px;margin:6px 0 0}.notice{padding:10px 14px;border-radius:10px;background:var(--bg);border:1px solid var(--line);margin:12px 0}
.privacy{color:var(--muted);font-size:13px;margin-top:14px}.signed{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:14px;margin-top:14px}
.linkbtn{background:none;border:0;color:var(--accent);cursor:pointer;font:inherit;padding:0;text-decoration:underline}
fieldset{border:0;padding:0;margin:0;min-width:0}.site-foot{border-top:1px solid var(--line);margin-top:40px;padding-top:16px;color:var(--muted);font-size:13px}`;

const THEMES = {
  dark: '--bg:#0f1115;--card:#171a21;--text:#eef0f4;--muted:#a3a9b7;--line:#2a2f3a',
  light: '--bg:#f6f7fb;--card:#ffffff;--text:#14161a;--muted:#5c6470;--line:#dfe3ea',
};
const WIDTHS = { narrow: '560px', normal: '720px', wide: '960px' };

const align = (d) => (d.align === 'center' ? ' center' : '');
const paragraph = (s) => (s ? `<p>${renderInline(s)}</p>` : '');
const externalLink = (href, inner, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}" target="_blank" rel="${REL}">${inner}</a>`;

// ---- blocks -----------------------------------------------------------------------------------------------------------
function renderHero(d, ctx) {
  const bg = assetSrc(d.imageUrl, { guildId: ctx.guild.id, base: ctx.assetBase });
  const link = safeUrl(d.buttonUrl);
  return `<header class="hero${align(d)}">${bg ? `<img class="hero-bg" src="${esc(bg)}" alt="" referrerpolicy="no-referrer">` : ''}<h1>${esc(d.title)}</h1>${d.subtitle ? `<p class="sub">${renderInline(d.subtitle)}</p>` : ''}${link && d.buttonLabel ? `<p class="btn-row">${externalLink(link, esc(d.buttonLabel), 'btn')}</p>` : ''}</header>`;
}
function renderImage(d, ctx) {
  const src = assetSrc(d.url, { guildId: ctx.guild.id, base: ctx.assetBase });
  if (!src) return '';
  const link = safeUrl(d.link);
  const img = `<img src="${esc(src)}" alt="${esc(d.alt)}" loading="lazy" referrerpolicy="no-referrer">`;
  return `<figure class="${['medium', 'small'].includes(d.width) ? d.width : 'full'}">${link ? externalLink(link, img) : img}${d.caption ? `<figcaption>${renderInline(d.caption)}</figcaption>` : ''}</figure>`;
}
function renderList(d) {
  const items = String(d.items ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => `<li>${renderInline(s)}</li>`).join('');
  const tag = d.style === 'numbers' ? 'ol' : 'ul';
  return `<${tag} class="list${d.style === 'checks' ? ' checks' : ''}">${items}</${tag}>`;
}

function field(q, ctx, st) {
  const id = `q-${ctx.blockId}-${q.id}`;
  const name = `f_${q.id}`;
  const value = st.values?.[q.id];
  const err = st.errors?.[q.id];
  const req = q.required ? ' required' : '';
  const label = `${esc(q.label)}${q.required ? ' <span class="req" aria-hidden="true">*</span>' : ''}`;
  const options = parseOptions(q.options);
  const help = q.help ? `<div class="help">${renderInline(q.help)}</div>` : '';
  const error = err ? `<p class="err" role="alert">${esc(err)}</p>` : '';
  const placeholder = q.placeholder ? ` placeholder="${esc(q.placeholder)}"` : '';
  const lengthAttrs = (q.max !== '' && q.max !== undefined && q.type !== 'number' ? ` maxlength="${esc(Math.min(Number(q.max) || 10000, 10000))}"` : '') + (q.min !== '' && q.min !== undefined && q.type !== 'number' ? ` minlength="${esc(Number(q.min) || 0)}"` : '');
  let control;
  switch (q.type) {
    case 'long': control = `<textarea id="${esc(id)}" name="${esc(name)}" rows="5"${req}${placeholder}${lengthAttrs}>${esc(value ?? '')}</textarea>`; break;
    case 'number': control = `<input id="${esc(id)}" type="number" step="any" name="${esc(name)}" value="${esc(value ?? '')}"${req}${placeholder}${q.min !== '' && q.min !== undefined ? ` min="${esc(Number(q.min))}"` : ''}${q.max !== '' && q.max !== undefined ? ` max="${esc(Number(q.max))}"` : ''}>`; break;
    case 'date': control = `<input id="${esc(id)}" type="date" name="${esc(name)}" value="${esc(value ?? '')}"${req}>`; break;
    case 'select': control = `<select id="${esc(id)}" name="${esc(name)}"${req}><option value="">Choose…</option>${options.map((o) => `<option value="${esc(o)}"${value === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`; break;
    case 'radio':
      return `<div class="q"><div class="lbl" id="${esc(id)}-l">${label}</div><div role="radiogroup" aria-labelledby="${esc(id)}-l">${options.map((o) => `<label class="opt"><input type="radio" name="${esc(name)}" value="${esc(o)}"${value === o ? ' checked' : ''}${req}> <span>${esc(o)}</span></label>`).join('')}</div>${help}${error}</div>`;
    case 'checkboxes': {
      const picked = Array.isArray(value) ? value : [];
      return `<div class="q"><div class="lbl">${label}</div>${options.map((o) => `<label class="opt"><input type="checkbox" name="${esc(name)}" value="${esc(o)}"${picked.includes(o) ? ' checked' : ''}> <span>${esc(o)}</span></label>`).join('')}${help}${error}</div>`;
    }
    case 'agree':
      return `<div class="q"><label class="opt"><input id="${esc(id)}" type="checkbox" name="${esc(name)}" value="on"${value === 'on' ? ' checked' : ''}${req}> <span>${esc(q.label)}${q.required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</span></label>${help}${error}</div>`;
    default: control = `<input id="${esc(id)}" type="text" name="${esc(name)}" value="${esc(value ?? '')}"${req}${placeholder}${lengthAttrs}>`;
  }
  return `<div class="q"><label for="${esc(id)}">${label}</label>${control}${help}${error}</div>`;
}

const BLOCKED = {
  member: 'This form is only for members of this server. Join the server, then come back and refresh this page.',
  already: 'You have already sent a response to this form.',
  cooldown: 'You sent a response recently. Please wait a little before sending another.',
  full: 'This form is not accepting more responses right now.',
};

function renderForm(block, ctx) {
  const d = block.data;
  const st = ctx.formState?.[block.id] || {};
  const c = { ...ctx, blockId: block.id };
  const head = `<h2>${esc(d.title)}</h2>${d.intro ? renderMarkdown(d.intro) : ''}`;
  const fields = (d.fields || []).map((q) => field(q, c, st)).join('');
  const privacy = `<p class="privacy">When you submit, the admins of ${esc(ctx.guild.name)} receive your answers together with your Discord username and ID.</p>`;
  let inner;
  if (ctx.mode === 'preview') {
    inner = `<div class="notice">Preview — the form is switched off here. Visitors log in with Discord before they can fill it in.</div><fieldset disabled>${fields}<button class="btn" type="button">${esc(d.submitLabel || 'Submit')}</button></fieldset>${privacy}`;
  } else if (!ctx.visitor) {
    inner = `<p>To fill in this form, log in with your Discord account. We only read your username and ID.</p><p class="btn-row"><a class="btn" href="${esc(ctx.loginHref)}">Log in with Discord</a></p>${privacy}`;
  } else if (st.blocked) {
    inner = `<div class="notice" role="status">${esc(st.message || BLOCKED[st.blocked] || BLOCKED.full)}</div>${signedIn(ctx)}`;
  } else {
    inner = `<form method="post" action="${esc(ctx.pagePath)}/f/${esc(block.id)}" autocomplete="off"><input type="hidden" name="_csrf" value="${esc(ctx.csrf(block.id))}">${st.formError ? `<p class="err" role="alert">${esc(st.formError)}</p>` : ''}${fields}<button class="btn" type="submit">${esc(d.submitLabel || 'Submit')}</button></form>${privacy}${signedIn(ctx)}`;
  }
  return `<section class="form" id="form-${esc(block.id)}">${head}${inner}</section>`;
}

const signedIn = (ctx) => `<form class="signed" method="post" action="/auth/visitor/logout"><input type="hidden" name="next" value="${esc(ctx.pagePath)}"><span>Signed in as <b>${esc(ctx.visitor.name)}</b></span><button class="linkbtn" type="submit">Not you?</button></form>`;

const RENDERERS = {
  hero: (d, ctx) => renderHero(d, ctx),
  heading: (d) => `<h${['1', '2', '3'].includes(String(d.level)) ? d.level : '2'} class="${align(d).trim()}">${esc(d.text)}</h${['1', '2', '3'].includes(String(d.level)) ? d.level : '2'}>`,
  text: (d) => `<div class="${align(d).trim()}">${renderMarkdown(d.body)}</div>`,
  image: (d, ctx) => renderImage(d, ctx),
  button: (d) => { const href = safeUrl(d.url); return href ? `<p class="btn-row${align(d)}">${externalLink(href, esc(d.label), `btn${d.style === 'outline' ? ' outline' : ''}`)}</p>` : ''; },
  list: (d) => renderList(d),
  divider: () => '<hr>',
  spacer: (d) => `<div class="spacer ${['s', 'm', 'l'].includes(d.size) ? d.size : 'm'}" aria-hidden="true"></div>`,
};

// ---- documents ----------------------------------------------------------------------------------------------------------
/** The <meta> tags that make a pasted link show a card (Discord reads Open Graph; `theme-color` becomes the card's edge colour). */
function linkPreviewTags(meta) {
  const tags = [
    ['name', 'description', meta.description], ['property', 'og:type', 'website'], ['property', 'og:site_name', meta.siteName],
    ['property', 'og:title', meta.title], ['property', 'og:description', meta.description], ['property', 'og:url', meta.url],
    ['property', 'og:image', meta.image], ['name', 'twitter:card', meta.card], ['name', 'theme-color', meta.color],
  ];
  return tags.filter(([, , value]) => value).map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`).join('');
}

function shell({ title, theme = THEME_DEFAULTS, guild, body, robots, refreshTo, meta }) {
  const t = { ...THEME_DEFAULTS, ...theme };
  const accent = /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : THEME_DEFAULTS.accent;
  const vars = `${THEMES[t.mode] || THEMES.dark};--accent:${accent};--on:${onAccent(accent)};--w:${WIDTHS[t.width] || WIDTHS.normal}`;
  const icon = guild?.icon && /^https:\/\/cdn\.discordapp\.com\//.test(guild.icon) ? `<img src="${esc(guild.icon)}" alt="" referrerpolicy="no-referrer">` : `<span class="ico" aria-hidden="true">${esc(String(guild?.name ?? '?').trim().slice(0, 1).toUpperCase())}</span>`;
  const brand = guild ? `<div class="brand">${icon}<span>${esc(guild.name)}</span></div>` : '';
  const foot = guild ? `<footer class="site-foot">This page was made by the admins of ${esc(guild.name)}. It is not made or endorsed by Discord. Never type your password, token or login codes into a web form.</footer>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin">${robots ? `<meta name="robots" content="${esc(robots)}">` : ''}${meta ? linkPreviewTags(meta) : ''}${refreshTo ? `<meta http-equiv="refresh" content="0;url=${esc(refreshTo)}">` : ''}<title>${esc(title)}</title><style>:root{${vars}}${CSS}</style></head><body><main class="wrap">${brand}${body}${foot}</main></body></html>`;
}

/**
 * @param {object} o
 * @param {{title: string, slug: string, theme: object, blocks: {id: string, type: string, data: object}[]}} o.page
 * @param {{id: string, name: string, icon?: string|null}} o.guild
 * @param {'public'|'preview'} [o.mode]
 * @param {{name: string}|null} [o.visitor]    the logged-in visitor, if any
 * @param {(blockId: string) => string} [o.csrf]
 * @param {string} [o.baseUrl]     the site's public address: with it (and `mode: 'public'`) the page carries link-preview tags
 * @param {string} [o.assetBase]   put in front of the address of uploaded pictures: '' on the public site (same origin), the dashboard's origin in the editor preview
 * @param {Record<string, {blocked?: string, message?: string, errors?: object, values?: object, formError?: string}>} [o.formState]
 */
export function renderPage({ page, guild, mode = 'public', visitor = null, csrf = () => '', formState = {}, assetBase = '', baseUrl = '' }) {
  const pagePath = `/s/${guild.id}/${page.slug}`;
  const ctx = { mode, guild, visitor, csrf, formState, assetBase, pagePath, loginHref: `/auth/visitor/login?next=${encodeURIComponent(pagePath)}` };
  const blocks = page.blocks.map((b) => (b.type === 'form' ? renderForm(b, ctx) : BLOCK_TYPES[b.type] ? RENDERERS[b.type]?.(b.data, ctx) ?? '' : '')).join('\n');
  // A page only some people may open needs a way to switch account even when it has no form (forms show this line themselves).
  const gated = page.access && page.access !== 'public';
  const body = visitor && gated && mode === 'public' && !page.blocks.some((b) => b.type === 'form') ? `${blocks}\n${signedIn(ctx)}` : blocks;
  const meta = mode === 'public' && baseUrl ? pageMeta(page, { guild, baseUrl }) : null; // notices, 404s, previews and gate pages never carry one
  return shell({ title: page.title || 'Untitled page', theme: page.theme, guild, body, robots: mode === 'preview' ? 'noindex' : undefined, meta });
}

/** A small page for thank-you / blocked / error messages, in the page's own theme. */
export function renderNotice({ page, guild, title, message, href, hrefLabel, refreshTo, visitor = null, pagePath = '' }) {
  const safeHref = href && (href.startsWith('/') && !href.startsWith('//') ? href : safeUrl(href));
  const link = safeHref ? `<p class="btn-row"><a class="btn outline" href="${esc(safeHref)}">${esc(hrefLabel || 'Back')}</a></p>` : '';
  const refresh = refreshTo ? safeUrl(refreshTo) : null; // only ever a validated http(s) address
  return shell({ title, theme: page?.theme, guild, body: `<div class="form"><h2>${esc(title)}</h2>${renderMarkdown(message)}${link}${visitor && pagePath ? signedIn({ visitor, pagePath }) : ''}</div>`, robots: 'noindex', refreshTo: refresh });
}

/** Deliberately says nothing about which servers or pages exist. */
export const renderNotFound = () => shell({ title: 'Page not found', body: '<div class="form"><h2>Page not found</h2><p>This page does not exist, or it is not published.</p></div>', robots: 'noindex' });
