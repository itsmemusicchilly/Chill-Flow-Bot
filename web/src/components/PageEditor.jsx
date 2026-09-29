import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { BLOCK_LIST, BLOCK_TYPES, formsOf, newBlock, normalizePage, THEME_FIELDS, validatePage } from '@shared/blocks.js';
import { renderPage } from '@shared/render-page.js';
import { uid } from '@shared/util.js';
import { api } from '../api.js';
import { useToast } from '../context.js';
import { FieldList } from './FieldEditor.jsx';
import ResponsesDialog from './ResponsesDialog.jsx';

const pick = (page) => structuredClone({ title: page.title, slug: page.slug, theme: page.theme, blocks: page.blocks });

export default function PageEditor({ gid, guild, page, dirtyRef, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => pick(page));
  const [selected, setSelected] = useState(null); // block id, or null for page settings
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showResponses, setShowResponses] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const focusRef = useRef(null);

  const markDirty = useCallback(() => { setDirty(true); dirtyRef.current = true; }, [dirtyRef]);
  useEffect(() => { dirtyRef.current = false; return () => { dirtyRef.current = false; }; }, [dirtyRef]);
  useEffect(() => {
    const warn = (e) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyRef]);

  const change = useCallback((patch) => { setDraft((d) => ({ ...d, ...patch })); markDirty(); }, [markDirty]);
  const setBlocks = useCallback((fn) => { setDraft((d) => ({ ...d, blocks: fn(d.blocks) })); markDirty(); }, [markDirty]);
  const updateBlock = (id, key, value) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, data: { ...b.data, [key]: value } } : b)));

  const addBlock = (type) => {
    const block = newBlock(type, uid(6));
    setBlocks((bs) => {
      const at = selected ? bs.findIndex((b) => b.id === selected) + 1 : bs.length;
      return [...bs.slice(0, at), block, ...bs.slice(at)];
    });
    setSelected(block.id);
  };
  const move = (id, d) => setBlocks((bs) => {
    const i = bs.findIndex((b) => b.id === id);
    const j = i + d;
    if (i < 0 || j < 0 || j >= bs.length) return bs;
    const next = [...bs];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const duplicate = (id) => {
    const copyId = uid(6);
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id);
      if (i < 0) return bs;
      const copy = { ...structuredClone(bs[i]), id: copyId };
      return [...bs.slice(0, i + 1), copy, ...bs.slice(i + 1)];
    });
    setSelected(copyId);
  };
  const remove = (id) => { setBlocks((bs) => bs.filter((b) => b.id !== id)); if (selected === id) setSelected(null); };

  // ---- validation and live preview (the exact renderer the public site uses) ---------------------------------------------
  const issues = useMemo(() => validatePage(normalizePage(draft)), [draft]);
  const issuesByBlock = useMemo(() => {
    const map = {};
    for (const i of issues) (map[i.blockId ?? '_page'] ||= []).push(i);
    return map;
  }, [issues]);
  const deferred = useDeferredValue(draft);
  const previewHtml = useMemo(
    () => renderPage({ page: normalizePage(deferred), guild: { id: gid, name: guild.name, icon: guild.icon }, mode: 'preview' }),
    [deferred, gid, guild.name, guild.icon],
  );

  // ---- saving and publishing ---------------------------------------------------------------------------------------------------
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const d = draftRef.current;
      const res = await api(`/guilds/${gid}/pages/${page.id}`, { method: 'PUT', body: { title: d.title, slug: d.slug, theme: d.theme, blocks: d.blocks } });
      setDraft(pick(res.page));
      setDirty(false);
      dirtyRef.current = false;
      onSaved(res.page);
      if (res.unpublished) toast('Saved — but the page was switched off because a form still needs fixing.', 'error');
      else toast(res.page.published ? 'Saved — the public page is updated.' : 'Saved.', 'ok');
    } catch (e) {
      const detail = e.data?.issues?.map((i) => i.message).join(' ') ?? '';
      toast(`${e.message}${detail ? ` ${detail}` : ''}`, 'error');
    } finally { setSaving(false); }
  }, [gid, page.id, onSaved, toast, dirtyRef]);

  useEffect(() => {
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const togglePublish = async (published) => {
    try {
      const res = await api(`/guilds/${gid}/pages/${page.id}`, { method: 'PUT', body: { published } });
      onSaved({ ...res.page, blocks: page.blocks, theme: page.theme, title: page.title, slug: page.slug }); // keep the saved content the page prop already has
      if (res.unpublished) toast('This page still has problems (see the list) so it stayed off.', 'error');
      else toast(published ? 'Published — anyone with the link can see it.' : 'Unpublished.', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };

  const publicUrl = `${window.location.origin}/s/${gid}/${draft.slug}`;
  const copyLink = () => navigator.clipboard?.writeText(publicUrl).then(() => toast('Link copied.', 'ok'), () => toast(publicUrl, 'info'));
  const selectedBlock = draft.blocks.find((b) => b.id === selected);
  const def = selectedBlock ? BLOCK_TYPES[selectedBlock.type] : null;
  const problemCount = issues.length;

  return (
    <div className="page-editor">
      <div className="flowbar">
        <input className="flow-name" aria-label="Page title" value={draft.title} maxLength={80} onChange={(e) => change({ title: e.target.value })} />
        <label className="slug" title={`Public address: ${publicUrl}`}>
          <span className="muted tiny">/s/…/</span>
          <input aria-label="Web address" value={draft.slug} maxLength={40} spellCheck={false} onChange={(e) => change({ slug: e.target.value.toLowerCase() })} />
        </label>
        <label className="switch" title={page.published ? 'Public — the saved version is live' : 'Not public yet'}>
          <input type="checkbox" checked={page.published} onChange={(e) => togglePublish(e.target.checked)} />
          <span className="track" /><span className="switch-label">{page.published ? 'Published' : 'Draft'}</span>
        </label>
        <span className={`issue-count ${problemCount ? 'bad' : 'ok'}`}>{problemCount ? `${problemCount} to fix` : '✓ No problems'}</span>
        <span className="spacer" />
        <button className="btn ghost small" onClick={copyLink}>Copy link</button>
        <a className={`btn ghost small ${page.published ? '' : 'disabled'}`} href={page.published ? `/s/${gid}/${page.slug}` : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!page.published}>Open ↗</a>
        <button className="btn ghost small" disabled={!formsOf(page).length} onClick={() => setShowResponses(true)} title={formsOf(page).length ? 'See what people submitted' : 'Add a form block and save first'}>Responses</button>
        <button className="btn primary" disabled={saving || !dirty} onClick={save} title="Ctrl+S">{saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
      </div>

      <div className="page-body">
        <aside className="outline" aria-label="Blocks">
          <h3>Add a block</h3>
          <div className="block-palette">
            {BLOCK_LIST.map((d) => (
              <button key={d.type} type="button" className="block-add" title={d.description} onClick={() => addBlock(d.type)}>
                <span aria-hidden="true">{d.icon}</span> {d.label}
              </button>
            ))}
          </div>
          <h3>Page</h3>
          <ol className="block-list">
            <li>
              <button className={`block-row ${selected === null ? 'on' : ''}`} onClick={() => setSelected(null)}>
                <span aria-hidden="true">⚙️</span><span className="block-label">Page settings</span>
                {issuesByBlock._page && <span className="badge bad" title={issuesByBlock._page.map((i) => i.message).join('\n')}>!</span>}
              </button>
            </li>
            {draft.blocks.length === 0 && <li className="muted tiny pad">No blocks yet — add one above.</li>}
            {draft.blocks.map((b, i) => {
              const d = BLOCK_TYPES[b.type];
              const bi = issuesByBlock[b.id] || [];
              return (
                <li key={b.id} className={`block-item ${selected === b.id ? 'on' : ''}`}>
                  <button className="block-row" onClick={() => setSelected(b.id)} aria-current={selected === b.id}>
                    <span aria-hidden="true">{d?.icon ?? '❓'}</span>
                    <span className="block-label">{d?.label ?? b.type}<small>{String(d?.summary?.(b.data) ?? '').slice(0, 34)}</small></span>
                    {bi.length > 0 && <span className="badge bad" title={bi.map((x) => x.message).join('\n')}>!</span>}
                  </button>
                  <span className="block-actions">
                    <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(b.id, -1)}>↑</button>
                    <button className="icon-btn" aria-label="Move down" disabled={i === draft.blocks.length - 1} onClick={() => move(b.id, 1)}>↓</button>
                    <button className="icon-btn" aria-label="Duplicate block" onClick={() => duplicate(b.id)}>⧉</button>
                    <button className="icon-btn danger" aria-label="Delete block" onClick={() => remove(b.id)}>✕</button>
                  </span>
                </li>
              );
            })}
          </ol>
        </aside>

        <section className="preview-wrap" aria-label="Preview">
          <div className="preview-note tiny muted">Live preview — exactly what visitors see. Forms are switched off here.</div>
          <iframe className="preview" title="Page preview" sandbox="" srcDoc={previewHtml} />
        </section>

        <aside className="inspector page-inspector" aria-label={selectedBlock ? 'Block settings' : 'Page settings'}>
          {selectedBlock && def ? (
            <>
              <header className="insp-head">
                <span className="fnode-ico" aria-hidden="true">{def.icon}</span>
                <div><h2>{def.label}</h2><p className="muted tiny">{def.description}</p></div>
              </header>
              {(issuesByBlock[selectedBlock.id] || []).length > 0 && (
                <ul className="issues">{issuesByBlock[selectedBlock.id].map((i, k) => <li key={k} className={i.level}>{i.message}</li>)}</ul>
              )}
              <div className="insp-fields">
                <FieldList fields={def.fields} data={selectedBlock.data} onChange={(k, v) => updateBlock(selectedBlock.id, k, v)} focusRef={focusRef} />
                {def.fields.length === 0 && <p className="muted tiny">Nothing to set for this block.</p>}
                {selectedBlock.type === 'form' && (
                  <p className="tiny muted">Build a flow with the <b>Form Submitted</b> trigger to react to each response (send a message, give a role, …). Save this page first so the form shows up in the trigger’s list.</p>
                )}
              </div>
            </>
          ) : (
            <>
              <header className="insp-head">
                <span className="fnode-ico" aria-hidden="true">⚙️</span>
                <div><h2>Page settings</h2><p className="muted tiny">Look and address of this page.</p></div>
              </header>
              {(issuesByBlock._page || []).length > 0 && <ul className="issues">{issuesByBlock._page.map((i, k) => <li key={k} className={i.level}>{i.message}</li>)}</ul>}
              <div className="insp-fields">
                <FieldList fields={THEME_FIELDS} data={draft.theme} onChange={(k, v) => change({ theme: { ...draft.theme, [k]: v } })} focusRef={focusRef} />
                <div className="field">
                  <label htmlFor="page-url">Public link</label>
                  <input id="page-url" type="text" readOnly value={publicUrl} onFocus={(e) => e.target.select()} />
                  <div className="help">{page.published ? 'Anyone with this link can open the saved page.' : 'Not public yet — switch the page to Published (top bar).'}</div>
                </div>
                <p className="tiny muted">Every page shows a footer saying it was made by your admins, not Discord. Visitors log in with Discord before they can fill in a form; the admins see their Discord name and ID with each answer.</p>
              </div>
            </>
          )}
        </aside>
      </div>
      {showResponses && <ResponsesDialog gid={gid} page={page} onClose={() => setShowResponses(false)} />}
    </div>
  );
}
