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
