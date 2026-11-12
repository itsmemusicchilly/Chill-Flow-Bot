// Ranking the values of one remembered variable (a leaderboard). Shared by SQLite and the cloud stores, so every database agrees on the order.
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;

/** The value as a number: a stored number, or text that is one ("10"). Anything else (text, a list, true) is not ranked. */
function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMBER.test(value.trim())) return Number(value);
  return null;
}

/** Ids are Discord snowflakes: the shorter (older) one first, so two equal scores always come out in the same order. */
const byId = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {{id: string, value: any}[]} rows every holder of the variable
 * @param {{limit?: number, descending?: boolean, id?: string}} options `id` = whose own place to report as well
 * @returns {{entries: {rank: number, id: string, value: number}[], total: number, rank: number|null, value: number|null}}
 */
export function rankRows(rows, { limit = 10, descending = true, id = '' } = {}) {
  const ranked = [];
  for (const row of rows) {
    const value = numberOf(row.value);
    if (value !== null) ranked.push({ id: String(row.id), value });
  }
  ranked.sort((a, b) => (descending ? b.value - a.value : a.value - b.value) || byId(a.id, b.id));
  const own = id ? ranked.findIndex((r) => r.id === String(id)) : -1;
  return {
    entries: ranked.slice(0, Math.max(0, limit)).map((r, i) => ({ rank: i + 1, id: r.id, value: r.value })),
    total: ranked.length,
    rank: own === -1 ? null : own + 1,
    value: own === -1 ? null : ranked[own].value,
  };
}
