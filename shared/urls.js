/**
 * The only way a URL from page content may reach an href/src/redirect. Returns the normalised absolute URL, or null.
 * Accepts https (and http unless `httpsOnly`); rejects anything else (javascript:, data:, relative, …), whitespace or control
 * characters, and URLs carrying credentials (`https://discord.com@evil.example` style tricks).
 */
export function safeUrl(value, { httpsOnly = false } = {}) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 2048 || /[\u0000- \u007f]/.test(s)) return null;
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !httpsOnly)) return null;
  if (url.username || url.password) return null;
  return url.href;
}

// ---- uploaded images ----------------------------------------------------------------------------------------------------
// An uploaded picture is referenced as `upload:<id>` wherever an image address is expected (pages, message embeds). The id is
// 16 random characters; the file itself lives at /i/<serverId>/<id>.webp.
export const UPLOAD_ID_RE = /^[a-z0-9]{16}$/;
const UPLOAD_REF_RE = /^upload:([a-z0-9]{16})$/;
export const GUILD_ID_RE = /^\d{5,25}$/;

export const uploadRef = (id) => `upload:${id}`;
/** The id inside an `upload:<id>` reference, or null for anything else (a link, junk, a longer or shorter id, …). */
export const uploadIdOf = (value) => (typeof value === 'string' ? UPLOAD_REF_RE.exec(value.trim())?.[1] ?? null : null);
/** Anything starting with `upload:` is meant as a reference, so a malformed one is a mistake, not a link. */
export const looksLikeUpload = (value) => typeof value === 'string' && /^upload:/i.test(value.trim());
export const uploadPath = (guildId, id) => `/i/${guildId}/${id}.webp`;

/**
 * The address to use in an <img> or CSS url() for an image field: an uploaded picture (a same-origin path, prefixed with `base`
 * when it must be absolute) or an https link. Anything else gives null. (Whether the picture belongs to this server is decided
 * by the file route, which answers 404 for another server's id.)
 */
export function assetSrc(value, { guildId, base = '' } = {}) {
  const id = uploadIdOf(value);
  if (id) return GUILD_ID_RE.test(String(guildId ?? '')) ? `${base}${uploadPath(guildId, id)}` : null;
  if (looksLikeUpload(value)) return null;
  return safeUrl(value, { httpsOnly: true });
}
