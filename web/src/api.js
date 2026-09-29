export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('fc:unauthorized'));
    throw new ApiError(res.status, data?.error || res.statusText || 'Request failed', data);
  }
  return data;
}

export async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
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
