const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short random id. Only [a-z0-9] so it is safe inside Discord custom ids. */
export function uid(n = 8) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** JSON with sorted keys, so two values that mean the same always give the same text (used to spot real changes). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
