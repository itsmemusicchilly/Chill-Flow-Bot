// What every "the count changed" watcher (YouTube subscribers, Twitch followers, TikTok followers) shares: remember the last count it saw
// and say what changed since. Pure, so it is tested without any platform.
//
// - The first look only remembers the count (like every other watcher: nothing is announced for what was already there) — except in "change"
//   mode, which is made for counters and runs once so the counter shows the right number straight away.
// - "gain" mode runs only when the count went up; "change" mode runs on every change, up or down.
// - A count that belongs to another account than the one remembered starts over (see `owner`).
// - A count that falls is remembered, so a count that then rises again is announced again (it really is new people).
// - It runs once per look with the number gained, not once per person: a platform only tells us the total.

/**
 * @returns {{state: object, fire: {count: number, previous: number, change: number, gained: number}[], log: {level: string, message: string}[]}}
 */
export function evaluateCount(state, count, { mode, noun, name, owner }) {
  if (!Number.isFinite(count)) return { state, fire: [], log: [] };
  // The count now belongs to a different account than the one that was remembered (the first connected account changed, or another was chosen):
  // its total says nothing about the old one, so start again from this look instead of announcing a jump of thousands.
  if (state?.baselined && owner !== undefined && state.owner !== undefined && state.owner !== owner) state = null;
  if (!state?.baselined) {
    return {
      state: { ...(state ?? {}), baselined: true, count, ...(owner !== undefined ? { owner } : {}) },
      fire: mode === 'change' ? [{ count, previous: count, change: 0, gained: 0 }] : [],
      log: [{ level: 'info', message: `Now watching ${name}: ${count.toLocaleString('en-US')} ${noun}. It will run ${mode === 'change' ? 'whenever the count changes' : 'each time the count goes up'}.` }],
    };
  }
  const change = count - state.count;
  if (change === 0) return { state, fire: [], log: [] };
  const next = { ...state, count, ...(owner !== undefined ? { owner } : {}) };
  if (change > 0 || mode === 'change') return { state: next, fire: [{ count, previous: state.count, change, gained: Math.max(0, change) }], log: [] };
  return { state: next, fire: [], log: [] };
}

/** The variables of one run: `{{<ns>.<noun>}}`, `.gained`, `.change`, `.previous`. */
export const countData = (noun, facts) => ({ [noun]: facts.count, gained: facts.gained, change: facts.change, previous: facts.previous });
