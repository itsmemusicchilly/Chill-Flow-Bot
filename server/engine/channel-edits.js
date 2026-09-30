// Discord lets a channel's name or topic change only about twice every ten minutes. discord.js knows this and, by default, simply
// WAITS — so a flow like "member joins → rename the counter channel" hangs from the third join on, runs pile up behind each other,
// and the name is stale by the time it applies. This keeps count of the bot's own changes per channel instead: while there is
// budget a change is made at once (exactly as before); when there is not, the newest name/topic is held and applied ONCE when
// Discord allows it. Nothing waits, nothing queues up, and the channel ends up with the latest value.

export const WINDOW_MS = 10 * 60_000;
export const PER_WINDOW = 2;
const MARGIN_MS = 1_000; // a little slack so we do not knock on the door a moment too early

export class ChannelEdits {
  /** Clock and timers are injectable so tests run on fake time. */
  constructor({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.channels = new Map(); // "guild|channel" → { stamps: number[], pending: null | { patch, run, report, at, timer } }
  }

  #state(key) {
    if (!this.channels.has(key)) this.channels.set(key, { stamps: [], pending: null });
    return this.channels.get(key);
  }

  #count(state) {
    const t = this.now();
    state.stamps = state.stamps.filter((s) => t - s < WINDOW_MS);
  }

  #stamp(state) {
    state.stamps.push(this.now());
    if (state.stamps.length > PER_WINDOW) state.stamps.shift();
  }

  /**
   * Ask to change a channel's name and/or topic.
   * @param {{name?: string, topic?: string}} patch
   * @param {(patch: object) => Promise<void>} run   makes the change (called later if it has to wait)
   * @param {(error: Error|null) => void} report     told how a *held* change ended (the run that asked is long gone)
   * @returns {null | {at: number, wait: number}} `null`: go ahead now (it is counted). Otherwise the change is held and will be made
   *   at `at` (ms since the epoch), which is `wait` ms from now.
   */
  request(guildId, channelId, patch, run, report = () => {}) {
    const key = `${guildId}|${channelId}`;
    const state = this.#state(key);
    this.#count(state);
    if (!state.pending && state.stamps.length < PER_WINDOW) { this.#stamp(state); return null; }

    if (state.pending) { // a newer request replaces the older one: only the latest values matter
      Object.assign(state.pending.patch, patch);
      state.pending.run = run;
      state.pending.report = report;
      return { at: state.pending.at, wait: Math.max(0, state.pending.at - this.now()) };
    }
    const at = state.stamps[state.stamps.length - PER_WINDOW] + WINDOW_MS + MARGIN_MS;
    const timer = this.setTimer(() => this.#fire(key), Math.max(0, at - this.now()));
    timer.unref?.();
    state.pending = { patch: { ...patch }, run, report, at, timer };
    return { at, wait: Math.max(0, at - this.now()) };
  }

  async #fire(key) {
    const state = this.channels.get(key);
    const held = state?.pending;
    if (!held) return;
    state.pending = null;
    this.#count(state);
    this.#stamp(state);
    try { await held.run(held.patch); held.report(null); } catch (err) { held.report(err); }
  }

  /** The bot left a server, or is shutting down: drop everything that is waiting. */
  cancel(guildId) {
    for (const [key, state] of this.channels) {
      if (guildId !== undefined && !key.startsWith(`${guildId}|`)) continue;
      if (state.pending) this.clearTimer(state.pending.timer);
      this.channels.delete(key);
    }
  }
}
