// Async code that never awaits real I/O (a cycle of “Log” nodes, a loop with nothing connected) would run as a chain of
// microtasks and starve timers and network I/O for the whole bot. Long-running work calls this every so often.
export const YIELD_EVERY = 200;
export const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
