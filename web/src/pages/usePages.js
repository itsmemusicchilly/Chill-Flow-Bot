import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context.js';

/** Everything the editor needs to know about a server's pages: the list, the open page, and the forms (for flow triggers). */
export function usePages({ gid, pageId, navigate, confirmLeave, dirtyRef }) {
  const toast = useToast();
  const [pages, setPages] = useState(null);
  const [forms, setForms] = useState([]);
  const [page, setPage] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api(`/guilds/${gid}/pages`), api(`/guilds/${gid}/forms`)])
      .then(([p, f]) => { if (alive) { setPages(p); setForms(f); } })
      .catch((e) => alive && toast(e.message, 'error'));
    return () => { alive = false; };
  }, [gid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pages) return undefined;
    if (!pageId) { setPage(null); return undefined; }
    if (page?.id === pageId) return undefined;
    let alive = true;
    api(`/guilds/${gid}/pages/${pageId}`)
      .then((r) => alive && setPage(r.page))
      .catch((e) => { if (alive) { toast(e.message, 'error'); navigate(gid); } });
    return () => { alive = false; };
  }, [pageId, pages, gid]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshForms = useCallback(() => api(`/guilds/${gid}/forms`).then(setForms).catch(() => {}), [gid]);

  const openPage = (id) => { if (id !== pageId && confirmLeave()) navigate(gid, null, id); };

  const createPage = async (payload) => {
    const res = await api(`/guilds/${gid}/pages`, { method: 'POST', body: payload });
    setPages((l) => [...l, res.page]);
    setPage(res.page);
    navigate(gid, null, res.page.id);
    refreshForms();
    toast('Page created. Edit it, then switch it on to publish.', 'ok');
  };

  const removePage = async (p) => {
    if (!window.confirm(`Delete “${p.title}”? Its form responses are erased too. This cannot be undone.`)) return;
    try {
      await api(`/guilds/${gid}/pages/${p.id}`, { method: 'DELETE' });
      setPages((l) => l.filter((x) => x.id !== p.id));
      if (p.id === pageId) { dirtyRef.current = false; setPage(null); navigate(gid); }
      refreshForms();
    } catch (e) { toast(e.message, 'error'); }
  };

  const duplicatePage = async (p) => {
    try {
      const res = await api(`/guilds/${gid}/pages/${p.id}/duplicate`, { method: 'POST' });
      setPages((l) => [...l, res.page]);
      openPage(res.page.id);
      refreshForms();
    } catch (e) { toast(e.message, 'error'); }
  };

  const onPageSaved = useCallback((saved) => {
    setPage(saved);
    setPages((l) => l.map((p) => (p.id === saved.id ? saved : p)));
    refreshForms();
  }, [refreshForms]);

  return { pages, page, forms, openPage, createPage, removePage, duplicatePage, onPageSaved };
}
