import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFile } from '../api.js';

export const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 104857.6) / 10} MB`;
}

/** The server's uploaded pictures: the list, usage, and uploading / deleting. */
export function useUploads(gid, maxBytes) {
  const [items, setItems] = useState(null);
  const [usage, setUsage] = useState({ count: 0, bytes: 0 });
  const [progress, setProgress] = useState([]); // [{ key, name, state: 'sending' | 'done' | 'error', message }]
  const [error, setError] = useState('');
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api(`/guilds/${gid}/uploads`);
      setItems(r.uploads);
      setUsage(r.usage);
      setError('');
    } catch (e) { setError(e.message); }
  }, [gid]);
  useEffect(() => { refresh(); }, [refresh]);

  /** Uploads one file after the other. Returns the pictures that are now available (new ones and duplicates). */
  const upload = useCallback(async (files) => {
    if (busy.current) return [];
    busy.current = true;
    const stored = [];
    const rows = files.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, state: 'sending', message: '' }));
    setProgress(rows);
    const mark = (key, patch) => setProgress((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    try {
      for (const [i, file] of files.entries()) {
        const { key } = rows[i];
        if (!ACCEPT.includes(file.type)) { mark(key, { state: 'error', message: 'Only PNG, JPEG, WebP and GIF pictures can be uploaded.' }); continue; }
        if (maxBytes && file.size > maxBytes) { mark(key, { state: 'error', message: `Too large (the most this server takes is ${formatBytes(maxBytes)}).` }); continue; }
        try {
          const r = await uploadFile(`/guilds/${gid}/uploads`, file);
          stored.push(r.upload);
          mark(key, { state: 'done', message: r.duplicate ? 'You already had this picture.' : '' });
          setItems((cur) => (cur && !cur.some((x) => x.id === r.upload.id) ? [{ ...r.upload, uses: { pages: [], flows: [] } }, ...cur] : cur));
        } catch (e) { mark(key, { state: 'error', message: e.message }); }
      }
    } finally { busy.current = false; }
    await refresh(); // exact usage numbers, and anything another admin added meanwhile
    return stored;
  }, [gid, maxBytes, refresh]);

  /** Returns where the picture was used (so the caller can say what lost its picture). */
  const remove = useCallback(async (u) => {
    const r = await api(`/guilds/${gid}/uploads/${u.id}`, { method: 'DELETE' });
    setItems((cur) => cur?.filter((x) => x.id !== u.id) ?? cur);
    await refresh();
    return r.uses;
  }, [gid, refresh]);

  const ids = useMemo(() => (items ? new Set(items.map((u) => u.id)) : null), [items]);
  return { items, usage, ids, error, progress, upload, remove, refresh, clearProgress: () => setProgress([]) };
}
