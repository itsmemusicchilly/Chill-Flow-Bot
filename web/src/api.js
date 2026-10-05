export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request(path, init) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('fc:unauthorized'));
    throw new ApiError(res.status, data?.error || res.statusText || 'Request failed', data);
  }
  return data;
}

export const api = (path, { method = 'GET', body } = {}) => request(path, {
  method,
  headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

/** Send one picture as the raw request body (the file name travels in a header, only as a label). */
export const uploadFile = (path, file) => request(path, {
  method: 'POST',
  headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) },
  body: file,
});

export async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
}

/**
 * Coming back from Twitch / TikTok ("Connect …"): what the address says about it, read once and then removed from the address.
 * Returns `{ result: 'ok' | 'denied' | 'failed', message, error }`, or null when this is not such a visit.
 */
export function takeConnectResult() {
  const q = new URLSearchParams(window.location.search);
  const result = q.get('connect');
  if (!result) return null;
  const label = { twitch: 'Twitch', tiktok: 'TikTok' }[q.get('provider')] ?? 'The account';
  const reason = q.get('reason');
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  if (result === 'ok') return { result, message: `${label} connected.`, error: false };
  if (result === 'denied') return { result, message: `${label} was not connected: the approval was cancelled.`, error: true };
  return { result: 'failed', message: reason || `${label} could not be connected. Try again.`, error: true };
}

/** `#/g/<guildId>` · `#/g/<guildId>/f/<flowId>` · `#/g/<guildId>/p/<pageId>` */
export function parseHash(hash = window.location.hash) {
  const m = hash.match(/^#\/g\/(\d+)(?:\/([fp])\/([\w-]+))?/);
  return { guildId: m?.[1] ?? null, flowId: m?.[2] === 'f' ? m[3] : null, pageId: m?.[2] === 'p' ? m[3] : null };
}
export function hashFor(guildId, flowId, pageId) {
  if (!guildId) return '#/';
  if (flowId) return `#/g/${guildId}/f/${flowId}`;
  if (pageId) return `#/g/${guildId}/p/${pageId}`;
  return `#/g/${guildId}`;
}
