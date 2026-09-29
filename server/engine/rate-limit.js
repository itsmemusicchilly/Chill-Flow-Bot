/** Sliding-window limiter keyed by string (e.g. a guild id). */
export class RateLimiter {
  constructor(max, windowMs, now = () => Date.now()) {
    this.max = max; this.windowMs = windowMs; this.now = now; this.hits = new Map(); this.lastPrune = now();
  }

  /** Records a hit and returns whether it is within the limit. */
  take(key) {
    const t = this.now();
    this.#maybePrune(t);
    const arr = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }

  #maybePrune(t) {
    if (t - this.lastPrune < this.windowMs * 4) return;
    this.lastPrune = t;
    for (const [k, arr] of this.hits) if (!arr.some((x) => t - x < this.windowMs)) this.hits.delete(k);
  }
}

/** Remembers bot-initiated changes so the events they cause can be ignored (prevents feedback loops). */
export class SelfActions {
  constructor(ttlMs = 15000, now = () => Date.now()) { this.ttl = ttlMs; this.now = now; this.map = new Map(); }

  /** Call BEFORE the Discord request (the gateway event can beat the HTTP response). Returns a cancel(). */
  expect(key) {
    const expires = this.now() + this.ttl;
    const arr = this.map.get(key) || [];
    arr.push(expires);
    this.map.set(key, arr);
    return () => { const a = this.map.get(key); const i = a ? a.indexOf(expires) : -1; if (i >= 0) a.splice(i, 1); };
  }

  /** Like consume() but leaves the expectation in place. */
  peek(key) {
    const arr = this.map.get(key);
    const t = this.now();
    return Boolean(arr?.some((x) => x >= t));
  }

  /** True (once per expectation) if the bot itself caused this event. */
  consume(key) {
    const arr = this.map.get(key);
    if (!arr) return false;
    const t = this.now();
    while (arr.length && arr[0] < t) arr.shift();
    if (!arr.length) { this.map.delete(key); return false; }
    arr.shift();
    if (!arr.length) this.map.delete(key);
    return true;
  }
}
