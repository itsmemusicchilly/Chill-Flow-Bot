// A clock the test moves by hand: the runtime reads the time and sets its timers through it (`Runtime({ clock })`).
export function fakeClock(start) {
  let t = start;
  const timers = [];
  const live = () => timers.filter((x) => !x.off && !x.done);
  return {
    clock: {
      now: () => t,
      setTimer: (fn, ms) => { const timer = { fn, at: t + ms, off: false, done: false, unref() {} }; timers.push(timer); return timer; },
      clearTimer: (timer) => { timer.off = true; },
    },
    now: () => t,
    waiting: () => live().length,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = live().sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        t = Math.max(t, next.at); next.done = true;
        await next.fn();
      }
      t = end;
    },
  };
}
