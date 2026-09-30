// Watches things outside Discord (feeds, and later platform APIs) and starts flows when something new appears.
//
// One `target` per thing to look at (a feed address), however many servers watch it: it is fetched once per round and every watching flow gets
// its own turn to see what is new. Each flow keeps its own memory of what it has already announced (in SQLite), so a restart never repeats a post
// and a freshly switched-on flow does not announce the back catalogue. The runtime's minute ticker calls `tick`; nothing here blocks it.
import { FeedSettingError } from '../../shared/feeds.js';
import { isCapped, LIMITS } from '../../shared/limits.js';

const MINUTE = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * MINUTE;
const errorText = (err) => String(err?.message ?? err).slice(0, 200);

export class Watchers {
  /**
   * @param {{runtime: object, db: object, logger: object, adapters: object[], fetch: Function, minMinutes?: number, maxParallel?: number}} deps
   *   `fetch(url, options)` is the guarded fetcher (server/net/safe-fetch.js), or a pretend one in tests.
   */
  constructor({ runtime, db, logger, adapters, fetch, minMinutes = 5, maxParallel = 4 }) {
    this.runtime = runtime;
    this.db = db;
    this.logger = logger;
    this.adapters = new Map(adapters.map((a) => [a.type, a]));
    this.fetch = fetch;
    this.minMinutes = minMinutes;
    this.maxParallel = maxParallel;
    this.subs = new Map(); // "guild|flow|node" → one flow's interest in one target
    this.targets = new Map(); // "type|key" → the thing being looked at
    this.pass = null; // the round of checks in progress, if any
    this.stopped = false;
  }

  get size() { return this.subs.size; }

  #log(sub, level, message) {
    this.logger.log(sub.guildId, level, message, { flowId: sub.flow.id, flowName: sub.flow.name, nodeId: sub.node.id });
  }

  // ---- what to watch ------------------------------------------------------------------------------------------------------------
  /** Called whenever a server's flows are (re)loaded: start watching what is new, stop watching what is gone, keep what is unchanged. */
  sync(guildId) {
    this.stopped = false;
    const now = this.runtime.clock.now(); // the runtime's clock, so tests (and only tests) can move time
    const keepSubs = new Set();
    let count = 0;
    for (const [type, adapter] of this.adapters) {
      for (const { flow, node } of this.runtime.index.get(guildId)?.triggers.get(type) ?? []) {
        const key = `${guildId}|${flow.id}|${node.id}`;
        let plan;
        try { plan = adapter.prepare(node.data, { minMinutes: this.minMinutes }); } catch (err) {
          if (err instanceof FeedSettingError) continue; // already shown as a problem on the node, and the trigger is not active
          throw err;
        }
        count += 1;
        const known = this.subs.get(key);
        if (isCapped(LIMITS.feedsPerGuild) && count > LIMITS.feedsPerGuild && !known) {
          this.logger.log(guildId, 'warn', `“${flow.name}” is not watching anything: this server reached its limit of ${LIMITS.feedsPerGuild} watched feeds.`, { flowId: flow.id, flowName: flow.name, nodeId: node.id });
          continue;
        }
        keepSubs.add(key);
        const targetKey = `${type}|${plan.key}`;
        if (known && known.targetKey === targetKey) { Object.assign(known, { flow, node, everyMs: plan.everyMs, label: plan.label }); continue; }
        if (known) this.#unsubscribe(known);
        const saved = this.db.getWatch(guildId, flow.id, node.id);
        const sub = { key, guildId, flow, node, adapter, type, targetKey, plan, everyMs: plan.everyMs, label: plan.label, state: saved, keyOf: plan.key };
        this.subs.set(key, sub);
        let target = this.targets.get(targetKey);
        if (!target) {
          target = { key: plan.key, type, targetKey, subs: new Set(), everyMs: plan.everyMs, nextAt: now, fails: 0, lastError: '', meta: {}, label: plan.label };
          this.targets.set(targetKey, target);
        }
        target.subs.add(key);
      }
    }
    for (const [key, sub] of [...this.subs]) if (sub.guildId === guildId && !keepSubs.has(key)) this.#unsubscribe(sub);
    for (const target of this.targets.values()) target.everyMs = Math.min(...[...target.subs].map((k) => this.subs.get(k).everyMs));
    this.db.pruneWatch(guildId, new Set([...this.subs.values()].filter((s) => s.guildId === guildId).map((s) => `${s.flow.id}|${s.node.id}`)));
  }

  #unsubscribe(sub) {
    this.subs.delete(sub.key);
    const target = this.targets.get(sub.targetKey);
    if (!target) return;
    target.subs.delete(sub.key);
    if (!target.subs.size) this.targets.delete(sub.targetKey);
  }

  clear(guildId) {
    for (const sub of [...this.subs.values()]) if (sub.guildId === guildId) this.#unsubscribe(sub);
  }

  stop() {
    this.stopped = true;
    this.subs.clear();
    this.targets.clear();
  }

  // ---- looking ----------------------------------------------------------------------------------------------------------------------
  /** Look at everything that is due. Returns the round in progress (a new round is not started while one is still running). */
  tick(now) {
    if (this.pass) return this.pass;
    const due = [...this.targets.values()].filter((t) => t.subs.size && t.nextAt <= now);
    if (!due.length) return Promise.resolve();
    const worker = async () => {
      for (let target = due.shift(); target; target = due.shift()) {
        try { await this.#look(target, now); } catch (err) { this.logger.log(null, 'error', `Watcher failed unexpectedly: ${err?.stack || err}`); }
      }
    };
    this.pass = Promise.all(Array.from({ length: Math.min(this.maxParallel, due.length) }, worker)).finally(() => { this.pass = null; });
    return this.pass;
  }

  /** Resolves when no round is running (for tests and for a clean shutdown). */
  async idle() { while (this.pass) await this.pass; }

  async #look(target, now) {
    const adapter = this.adapters.get(target.type);
    let result;
    try {
      result = await adapter.fetch(target, { fetch: this.fetch, now });
    } catch (err) {
      if (!this.stopped) this.#failed(target, err, now);
      return;
    }
    if (this.stopped) return;
    this.#succeeded(target, now);
    if (result?.unchanged) return;
    for (const key of [...target.subs]) {
      const sub = this.subs.get(key);
      if (sub) await this.#deliver(sub, result);
    }
  }

  #failed(target, err, now) {
    const message = errorText(err);
    target.fails += 1;
    const delay = Math.min(MAX_BACKOFF_MS, target.everyMs * 2 ** (target.fails - 1));
    target.nextAt = now + delay;
    if (target.fails === 1 || message !== target.lastError) {
      for (const key of target.subs) {
        const sub = this.subs.get(key);
        if (sub) this.#log(sub, 'warn', `“${target.label}” could not be read: ${message} Trying again in ${Math.max(1, Math.round(delay / MINUTE))} minute(s).`);
      }
    }
    target.lastError = message;
  }

  #succeeded(target, now) {
    if (target.fails > 0) {
      for (const key of target.subs) { const sub = this.subs.get(key); if (sub) this.#log(sub, 'info', `“${target.label}” can be read again.`); }
    }
    target.fails = 0;
    target.lastError = '';
    target.nextAt = now + target.everyMs;
  }

  async #deliver(sub, result) {
    // while the bot is not connected to this server nothing is announced AND nothing is marked as seen, so nothing is lost
    if (!this.runtime.client?.guilds.cache.has(sub.guildId)) return;
    const { state, fire, log } = sub.adapter.evaluate(sub.state, result, { key: sub.keyOf, label: sub.label });
    for (const line of log) this.#log(sub, line.level, line.message);
    if (state !== sub.state) {
      sub.state = state;
      this.db.setWatch(sub.guildId, sub.flow.id, sub.node.id, state); // remembered BEFORE the runs start: at worst a post is skipped, never announced twice
    }
    for (const item of fire) await this.runtime.fireWatched(sub, item);
  }
}
