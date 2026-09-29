// A tiny arithmetic evaluator (no eval): + - * / % ^, parentheses, unary minus, a few functions.
const FUNCS = { round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs, sqrt: Math.sqrt, min: Math.min, max: Math.max };

export function evaluate(source) {
  const src = String(source);
  if (src.length > 200) throw new Error('Expression is too long.');
  const tokens = src.match(/\s*(\d+\.?\d*|\.\d+|[A-Za-z]+|[-+*/%^(),]|\S)/g)?.map((t) => t.trim()) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const fail = (m) => { throw new Error(m || `Cannot calculate “${src}”.`); };

  function primary() {
    const t = next();
    if (t === undefined) fail();
    if (/^[\d.]/.test(t)) { const n = Number(t); if (!Number.isFinite(n)) fail(); return n; }
    if (t === '(') { const v = additive(); if (next() !== ')') fail(); return v; }
    if (t === '-') return -power();
    if (t === '+') return power();
    if (/^[A-Za-z]+$/.test(t)) {
      const fn = FUNCS[t.toLowerCase()];
      if (!fn || next() !== '(') fail(`Unknown function “${t}”.`);
      const args = [];
      if (peek() !== ')') { do { args.push(additive()); } while (peek() === ',' && next()); }
      if (next() !== ')') fail();
      return fn(...args);
    }
    return fail();
  }
  function power() {
    const base = primary();
    if (peek() === '^') { next(); return base ** power(); }
    return base;
  }
  function multiplicative() {
    let v = power();
    while (['*', '/', '%'].includes(peek())) {
      const op = next();
      const r = power();
      if ((op === '/' || op === '%') && r === 0) fail('Division by zero.');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function additive() {
    let v = multiplicative();
    while (peek() === '+' || peek() === '-') { const op = next(); const r = multiplicative(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  const result = additive();
  if (i !== tokens.length) fail();
  if (!Number.isFinite(result)) fail('The result is not a finite number.');
  return result;
}
