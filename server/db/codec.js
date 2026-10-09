// The cloud database runs in a worker thread. Values cross as JSON, which drops `undefined`, Set and Map,
// so those are wrapped before the trip and unwrapped after it.

export function encode(value) {
  if (value === undefined) return { __type: 'undefined' };
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Set) return { __type: 'set', values: [...value].map(encode) };
  if (value instanceof Map) return { __type: 'map', entries: [...value].map(([key, item]) => [encode(key), encode(item)]) };
  if (Array.isArray(value)) return value.map(encode);
  const out = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = encode(item);
  return out;
}

export function decode(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.__type === 'undefined') return undefined;
  if (value.__type === 'set') return new Set(value.values.map(decode));
  if (value.__type === 'map') return new Map(value.entries.map(([key, item]) => [decode(key), decode(item)]));
  if (Array.isArray(value)) return value.map(decode);
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = decode(item);
  return out;
}
