// What every "the count changed" watcher (YouTube subscribers, Twitch followers, TikTok followers) shares: remember the last count it saw
// and say what changed since. Pure, so it is tested without any platform.
//
// - The first look only remembers the count (like every other watcher: nothing is announced for what was already there) — except in "change"
//   mode, which is made for counters and runs once so the counter shows the right number straight away.
// - "gain" mode runs only when the count went up; "change" mode runs on every change, up or down.
// - A count that falls is remembered, so a count that then rises again is announced again (it really is new people).
// - It runs once per look with the number gained, not once per person: a platform only tells us the total.

/**
 * @returns {{state: object, fire: {count: number, previous: number, change: number, gained: number}[], log: {level: string, message: string}[]}}
 */
export function evaluateCount(state, count, { mode, noun, name }) {
  if (!Number.isFinite(count)) return { state, fire: [], log: [] };
  if (!state?.baselined) {
    return {
      state: { ...(state ?? {}), baselined: true, count },
      fire: mode === 'change' ? [{ count, previous: count, change: 0, gained: 0 }] : [],
      log: [{ level: 'info', message: `Now watching ${name}: ${count.toLocaleString('en-US')} ${noun}. It will run ${mode === 'change' ? 'whenever the count changes' : 'each time the count goes up'}.` }],
    };
  }
  const change = count - state.count;
  if (change === 0) return { state, fire: [], log: [] };
  const next = { ...state, count };
  if (change > 0 || mode === 'change') return { state: next, fire: [{ count, previous: state.count, change, gained: Math.max(0, change) }], log: [] };
  return { state: next, fire: [], log: [] };
}

/** The variables of one run: `{{<ns>.<noun>}}`, `.gained`, `.change`, `.previous`. */
export const countData = (noun, facts) => ({ [noun]: facts.count, gained: facts.gained, change: facts.change, previous: facts.previous });
