// CSV export of form responses. Answers are written by strangers, so a cell that starts with = + - @ (or a tab/CR) could
// be run as a formula when an admin opens the file in a spreadsheet: those are prefixed with an apostrophe.
export function csvCell(value) {
  let s = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A UTF-8 BOM keeps Excel from mangling non-ASCII names. */
export const toCsv = (header, rows) => `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
