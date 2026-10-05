// Pieces the account providers (Twitch, TikTok) share: the error they throw and the two request shapes they need.

/** Something wrong with a connected account, worded for the person who connected it. `expired` = it must be connected again. */
export class AccountError extends Error {
  constructor(message, { expired = false } = {}) {
    super(message);
    this.expired = expired;
  }
}

export const form = (params) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params).toString() });

export function json(res, who) {
  try {
    const v = JSON.parse(res.text);
    if (v && typeof v === 'object') return v;
  } catch { /* fall through */ }
  throw new AccountError(`${who}’s answer could not be read.`);
}
