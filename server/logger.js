// In-memory, per-server log buffers. Logs are never persisted and never shared across servers.
export class Logger {
  constructor({ perGuild = 300, maxGuilds = 500, console: out = true } = {}) {
    this.perGuild = perGuild; this.maxGuilds = maxGuilds; this.out = out;
    this.buffers = new Map();
    this.subs = new Map();
    this.seq = 0;
  }

  log(guildId, level, message, meta = {}) {
    const entry = { id: ++this.seq, ts: Date.now(), level, message: String(message), flowId: meta.flowId, flowName: meta.flowName, nodeId: meta.nodeId, runId: meta.runId };
    if (guildId) {
      let buf = this.buffers.get(guildId);
      if (buf) this.buffers.delete(guildId); else buf = [];
      buf.push(entry);
      if (buf.length > this.perGuild) buf.splice(0, buf.length - this.perGuild);
      this.buffers.set(guildId, buf); // re-insert = most recently used
      if (this.buffers.size > this.maxGuilds) this.buffers.delete(this.buffers.keys().next().value);
      for (const fn of this.subs.get(guildId) || []) { try { fn(entry); } catch { /* subscriber gone */ } }
    }
    if (this.out && level !== 'debug') console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${guildId ?? 'system'}] ${message}`);
    return entry;
  }

  recent(guildId, limit = 200) { return (this.buffers.get(guildId) || []).slice(-limit); }

  subscribe(guildId, fn) {
    let set = this.subs.get(guildId);
    if (!set) { set = new Set(); this.subs.set(guildId, set); }
    set.add(fn);
    return () => { set.delete(fn); if (!set.size) this.subs.delete(guildId); };
  }
}
