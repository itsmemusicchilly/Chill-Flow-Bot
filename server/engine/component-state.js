/** Remembers the run that sent a message so a later button click can read its variables. In memory only. */
export class ComponentState {
  constructor(max = 5000, ttlMs = 14 * 24 * 3600 * 1000) { this.max = max; this.ttl = ttlMs; this.map = new Map(); }

  remember(messageId, ctx) {
    const { original, ...data } = ctx.data; // only one level of "original"
    this.map.delete(messageId);
    this.map.set(messageId, { vars: ctx.vars, data: structuredClone(data), at: Date.now() });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  get(messageId) {
    const e = this.map.get(messageId);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttl) { this.map.delete(messageId); return undefined; }
    return e;
  }
}
