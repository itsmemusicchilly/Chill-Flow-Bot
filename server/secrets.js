// Seals secrets (the tokens of connected Twitch / TikTok accounts) before they are written to the database, so a copy of the database
// file alone does not give anyone access to those accounts. AES-256-GCM; the "aad" (server + provider) is bound to each sealed value, so a
// value cannot be moved to another server's row and still open.
//
// The key comes from TOKEN_ENCRYPTION_KEY, or — when that is not set — from DISCORD_CLIENT_SECRET. If the key ever changes, the sealed values
// simply no longer open: the connection then reads "reconnect" and nothing else is lost.
import crypto from 'node:crypto';

const VERSION = 'v1';
const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function createSealer({ key, fallback }) {
  const secret = String(key || fallback || '');
  if (!secret) throw new Error('A secret is needed to seal tokens (TOKEN_ENCRYPTION_KEY or DISCORD_CLIENT_SECRET).');
  const aesKey = Buffer.from(crypto.hkdfSync('sha256', secret, 'flowbot', 'linked-account-tokens', 32));

  /** @returns {string} `v1.<iv>.<tag>.<ciphertext>` */
  function seal(text, aad) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    cipher.setAAD(Buffer.from(String(aad)));
    const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
  }

  /** The original text, or null when the value is not one of ours, was changed, belongs to another row, or the key is different. */
  function open(sealed, aad) {
    try {
      const parts = String(sealed).split('.');
      const [version, iv, tag, ct] = parts;
      if (parts.length !== 4 || version !== VERSION || !iv || !tag) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(String(aad)));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  return { seal, open };
}
