const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short random id. Only [a-z0-9] so it is safe inside Discord custom ids. */
export function uid(n = 8) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
