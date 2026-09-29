// What Discord (and other chat apps) show when a page's link is pasted: a title, a short description, a picture and an accent
// colour. Pure data, no HTML — render-page.js turns it into <meta> tags (escaped) and the editor shows it as a small card.
//
// Nothing here needs setting up: the description falls back to the page's own text and the picture to its hero or the server icon.
import { THEME_DEFAULTS } from './blocks.js';
import { assetSrc } from './urls.js';

const DERIVED_MAX = 160;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Text without markdown marks, on one line. */
const plain = (s) => String(s ?? '')
  .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
  .replace(/\*{1,2}([^*\n]+)\*{1,2}/g, '$1')
  .replace(CONTROL, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const firstBlock = (page, type) => (page.blocks || []).find((b) => b.type === type)?.data ?? {};

/** The server icon at a size that looks fine in a link card (the dashboard asks Discord for 64 px). */
const iconAddress = (icon) => (typeof icon === 'string' && /^https:\/\/cdn\.discordapp\.com\//.test(icon) ? icon.replace(/([?&])size=\d+/, '$1size=256') : null);

/**
 * @param {{title?: string, slug: string, theme?: object, blocks?: object[]}} page
 * @param {{guild: {id: string, name: string, icon?: string|null}, baseUrl: string}} o  `baseUrl` (no trailing slash) makes every address absolute
 * @returns {{title: string, siteName: string, description: string, image: string|null, card: 'summary'|'summary_large_image', color: string, url: string}}
 */
export function pageMeta(page, { guild, baseUrl }) {
  const theme = page.theme ?? {};
  const hero = firstBlock(page, 'hero');
  const text = firstBlock(page, 'text');
  const description = plain(theme.description) || cut(plain(hero.subtitle), DERIVED_MAX) || cut(plain(String(text.body ?? '').split(/\n{2,}/)[0]), DERIVED_MAX);

  // A picture chosen for the page (or its hero) is wide; the server icon is square, so it is shown as a thumbnail.
  const absolute = (value) => { const src = assetSrc(value, { guildId: guild.id, base: baseUrl }); return src && !src.startsWith('/') ? src : null; };
  const picture = absolute(theme.previewImage) ?? absolute(hero.imageUrl);
  const icon = picture ? null : iconAddress(guild.icon);

  return {
    title: page.title || 'Untitled page',
    siteName: guild.name,
    description,
    image: picture ?? icon,
    card: picture ? 'summary_large_image' : 'summary',
    color: /^#[0-9a-f]{6}$/i.test(theme.accent) ? theme.accent : THEME_DEFAULTS.accent,
    url: `${baseUrl}/s/${guild.id}/${page.slug}`,
  };
}
