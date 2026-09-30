// When a Schedule trigger runs: "every N minutes", "at 09:00 on weekdays", or a cron expression, in a chosen time zone.
// Pure and dependency-free (only Intl), so the server decides WHEN to run and the editor checks and previews the very same rules.

/** A problem with what a person typed, worded so it can be shown as it is. */
export class CronError extends Error {}

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;
const NAMES = {
  month: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], // JAN = 1
  dow: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], // SUN = 0
};
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: NAMES.month, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: NAMES.dow, base: 0 }, // 7 is Sunday too
];
const SHORTCUTS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};
const MAX_EXPRESSION = 200;
const DAY_CHIPS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const WEEKDAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
export const MAX_EVERY_MS = 3650 * DAY_MS; // ten years: beyond that "every" is a typo, not a plan

const pad = (n) => String(n).padStart(2, '0');

function value(text, spec, whole) {
  if (/^\d+$/.test(text)) return Number(text);
  const at = spec.names ? spec.names.indexOf(text.toUpperCase()) : -1;
  if (at >= 0) return at + spec.base;
  throw new CronError(`The ${spec.name} field has “${text}”${whole === text ? '' : ` in “${whole}”`}, which is not ${spec.names ? 'a number or a name' : 'a number'}.`);
}

function parseField(source, spec) {
  const out = new Set();
  for (const part of source.split(',')) {
    if (!part) throw new CronError(`The ${spec.name} field “${source}” has an empty item (check for a stray comma).`);
    const [range, step, ...extra] = part.split('/');
    if (extra.length || (step !== undefined && !/^\d+$/.test(step)) || Number(step) === 0) {
      throw new CronError(`The ${spec.name} field “${part}” has a bad step: write it like */15 or 10-40/5.`);
    }
    let from; let to;
    if (range === '*') { from = spec.min; to = spec.max; if (spec.name === 'day of week') to = 6; }
    else if (range.includes('-')) {
      const [a, b, ...more] = range.split('-');
      if (more.length || a === '' || b === '') throw new CronError(`The ${spec.name} field “${part}” is not a valid range: write it like 1-5.`);
      from = value(a, spec, part); to = value(b, spec, part);
      if (from > to) throw new CronError(`The ${spec.name} field “${part}” goes backwards: write the smaller value first (a range cannot wrap around).`);
    } else {
      from = value(range, spec, part);
      to = step === undefined ? from : (spec.name === 'day of week' ? 6 : spec.max); // "5/15" means "from 5 onwards, every 15"
    }
    for (const v of [from, to]) {
      if (v < spec.min || v > spec.max) throw new CronError(`The ${spec.name} field has ${v}, but ${spec.name}s go from ${spec.min} to ${spec.max}.`);
    }
    for (let v = from; v <= to; v += step === undefined ? 1 : Number(step)) out.add(spec.name === 'day of week' && v === 7 ? 0 : v);
  }
  return out;
}

/**
 * Standard 5-field cron: `minute hour day-of-month month day-of-week`. Supports `*`, lists (1,15), ranges (1-5), steps (*\/15, 10-40/5),
 * month/day names (JAN, MON) and @hourly @daily @midnight @weekly @monthly @yearly. Like classic cron, when BOTH day fields are
 * restricted a day counts if EITHER matches; a day field that starts with `*` is not restricted.
 */
export function parseCron(expression) {
  const text = String(expression ?? '').trim();
  if (!text) throw new CronError('Write a cron expression, for example 0 9 * * 1-5 (09:00 on weekdays).');
  if (text.length > MAX_EXPRESSION) throw new CronError(`A cron expression is at most ${MAX_EXPRESSION} characters.`);
  let source = text;
  if (source.startsWith('@')) {
    source = SHORTCUTS[source.toLowerCase()];
    if (!source) throw new CronError(`“${text}” is not a known shortcut. Use @hourly, @daily, @weekly, @monthly or @yearly.`);
  }
  const fields = source.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(`A cron expression has 5 fields (minute hour day-of-month month day-of-week), but “${text}” has ${fields.length}.`);
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELDS[i]));
  return { source, minute, hour, dom, month, dow, domStar: fields[2].startsWith('*'), dowStar: fields[4].startsWith('*') };
}

/** "At a set time": `09:30` plus optional weekdays (`['mon','fri']`, none = every day) as the equivalent cron expression. */
export function timeToCron({ time, days } = {}) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new CronError('Write the time on a 24-hour clock, for example 09:30 or 18:00.');
  const chosen = Array.isArray(days) ? days : [];
  for (const d of chosen) if (!DAY_CHIPS.includes(d)) throw new CronError(`“${d}” is not a day of the week.`);
  const names = DAY_CHIPS.filter((d) => chosen.includes(d)).map((d) => d.toUpperCase());
  return `${Number(m[2])} ${Number(m[1])} * * ${names.length && names.length < 7 ? names.join(',') : '*'}`;
}

// ---- time zones ----------------------------------------------------------------------------------------------------
const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    if (formatters.size > 500) formatters.clear(); // zone names are typed by people; never let this grow without end
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try { formatterFor(timeZone); return true; } catch { return false; }
}

// The platform lists some zones under their old names (India is "Asia/Calcutta"). Both names work everywhere, so people are shown
// the current one and the old one is still accepted.
const MODERN_NAMES = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv', 'Atlantic/Faeroe': 'Atlantic/Faroe', 'Africa/Asmera': 'Africa/Asmara', 'America/Godthab': 'America/Nuuk',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'America/Catamarca': 'America/Argentina/Catamarca', 'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy', 'America/Mendoza': 'America/Argentina/Mendoza', 'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville', 'Pacific/Truk': 'Pacific/Chuuk', 'Pacific/Ponape': 'Pacific/Pohnpei', 'Pacific/Enderbury': 'Pacific/Kanton',
};
const currentName = (z) => (MODERN_NAMES[z] && isValidTimeZone(MODERN_NAMES[z]) ? MODERN_NAMES[z] : z);

/** The zones to offer, UTC first and the rest in order. Any other name the platform understands (old names, "US/Pacific") is accepted too. */
export function timeZoneNames() {
  try { return ['UTC', ...[...new Set(Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC').map(currentName))].sort()]; } catch { return ['UTC']; }
}

/** The zone this browser or server is in, when it is one we can use. */
export function localTimeZone() {
  try {
    const z = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(z) ? currentName(z) : 'UTC';
  } catch { return 'UTC'; }
}

/** What the wall clock in `timeZone` shows at `at` (a Date or ms). `key` identifies that local minute, e.g. `2026-10-04 09:00`. */
export function zonedParts(at, timeZone) {
  const p = {};
  for (const { type, value: v } of formatterFor(timeZone).formatToParts(at)) p[type] = v;
  const month = Number(p.month); const day = Number(p.day); const year = Number(p.year);
  const hour = Number(p.hour) % 24; const minute = Number(p.minute);
  return { year, month, day, hour, minute, dow: NAMES.dow.indexOf(p.weekday.toUpperCase()), key: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}` };
}

const dayMatches = (cron, parts) => {
  const dom = cron.dom.has(parts.day); const dow = cron.dow.has(parts.dow);
  return cron.domStar || cron.dowStar ? dom && dow : dom || dow;
};

export function cronMatches(cron, parts) {
  return cron.minute.has(parts.minute) && cron.hour.has(parts.hour) && cron.month.has(parts.month) && dayMatches(cron, parts);
}

/**
 * The next `count` moments (ms) after `from` when the expression matches the wall clock in `timeZone`, in the order they happen.
 * Skips ahead by whole days and hours instead of looking at every minute, gives up after `horizonDays` (so an impossible date such as
 * 31 February returns `[]`), and lists a repeated local time (clocks going back) once, like the runtime does.
 */
export function nextRuns(cron, timeZone, from, count = 1, { horizonDays = 366 * 9 } = {}) {
  const found = [];
  const end = from + horizonDays * DAY_MS;
  let t = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  let lastKey = '';
  for (let guard = 0; t <= end && found.length < count && guard < 200_000; guard += 1) {
    const parts = zonedParts(t, timeZone);
    if (!cron.month.has(parts.month) || !dayMatches(cron, parts)) {
      const next = t + ((24 - parts.hour) * 60 - parts.minute) * MINUTE; // to the next local midnight
      const after = zonedParts(next, timeZone);
      // clocks that went forward in between can land us past midnight: step back so the first hour of the next day is not skipped
      t = after.day !== parts.day && (after.hour || after.minute) ? Math.max(t + MINUTE, next - (after.hour * 60 + after.minute) * MINUTE) : next;
    } else if (!cron.hour.has(parts.hour)) t += (60 - parts.minute) * MINUTE; // to the next local hour
    else {
      if (cron.minute.has(parts.minute) && parts.key !== lastKey) { found.push(t); lastKey = parts.key; }
      t += MINUTE;
    }
  }
  return found;
}

/** A moment as people read it in a zone, e.g. `Wed 30 Sep 2026, 09:00`. */
export function formatInZone(at, timeZone) {
  const p = {};
  for (const { type, value: v } of new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)) p[type] = v;
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

// ---- a Schedule node's settings → when it runs ---------------------------------------------------------------------
/**
 * @returns {{mode: 'every', ms: number} | {mode: 'time'|'cron', tz: string, source: string, cron: object}}
 * @throws {CronError} when the settings cannot describe a schedule
 */
export function scheduleOf(d = {}) {
  const mode = d.mode === 'time' || d.mode === 'cron' ? d.mode : 'every'; // nodes saved before the modes existed have none
  if (mode === 'every') {
    const n = Number(d.every);
    if (!(n >= 1)) throw new CronError('Interval must be at least 1.');
    const unit = { minutes: MINUTE, hours: 60 * MINUTE, days: DAY_MS }[d.unit] ?? MINUTE;
    if (!Number.isFinite(n * unit) || n * unit > MAX_EVERY_MS) throw new CronError('That interval is longer than 10 years. Is it a typo?');
    return { mode, ms: Math.max(MINUTE, n * unit) };
  }
  const tz = d.timezone || 'UTC';
  if (!isValidTimeZone(tz)) throw new CronError(`“${tz}” is not a time zone this server knows. Pick one from the list, for example UTC or Europe/London.`);
  const source = mode === 'time' ? timeToCron(d) : String(d.cron ?? '').trim();
  return { mode, tz, source, cron: parseCron(source) };
}
