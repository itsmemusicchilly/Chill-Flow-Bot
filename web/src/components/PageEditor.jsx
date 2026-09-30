import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { BLOCK_LIST, BLOCK_TYPES, formsOf, newBlock, normalizePage, PREVIEW_FIELDS, THEME_FIELDS, validatePage } from '@shared/blocks.js';
import { renderPage } from '@shared/render-page.js';
import { uid } from '@shared/util.js';
import { api } from '../api.js';
import { useImages, useToast } from '../context.js';
import AccessSettings from './AccessSettings.jsx';
import { FieldList } from './FieldEditor.jsx';
import LinkPreviewCard from './LinkPreviewCard.jsx';
import MoreMenu from './MoreMenu.jsx';
import ResponsesDialog from './ResponsesDialog.jsx';

// What the editor works on: the DRAFT (title, look, link preview, blocks), the address and who may open the page.
const pick = (page) => structuredClone({ title: page.title, slug: page.slug, theme: page.theme, blocks: page.blocks, access: page.access, roleIds: page.roleIds });
const problemText = (e) => `${e.message}${e.data?.issues?.length ? ` ${e.data.issues.map((i) => i.message).join(' ')}` : ''}`;

export default function PageEditor({ gid, guild, roles, page, dirtyRef, onSaved }) {
  const toast = useToast();
  const { ids: pictureIds } = useImages();
  const [draft, setDraft] = useState(() => pick(page));
  const [selected, setSelected] = useState(null); // block id, or null for page settings
  const [pane, setPane] = useState('blocks'); // phones show one of blocks | preview | settings at a time (see the bottom tabs)
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false); // publishing, unpublishing or discarding
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
    setPane('settings');
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
  const issues = useMemo(() => validatePage(normalizePage(draft), { uploads: pictureIds ?? undefined }), [draft, pictureIds]);
  const issuesByBlock = useMemo(() => {
    const map = {};
    for (const i of issues) (map[i.blockId ?? '_page'] ||= []).push(i);
    return map;
  }, [issues]);
  const deferred = useDeferredValue(draft);
  const previewHtml = useMemo(
    () => renderPage({ page: normalizePage(deferred), guild: { id: gid, name: guild.name, icon: guild.icon }, mode: 'preview', assetBase: window.location.origin }),
    [deferred, gid, guild.name, guild.icon],
  );

  // ---- saving and publishing ---------------------------------------------------------------------------------------------------
  /** Saves the DRAFT. What visitors see does not change until you publish. Resolves to whether it worked. */
  const save = useCallback(async ({ quiet = false } = {}) => {
    setSaving(true);
    try {
      const d = draftRef.current;
      const res = await api(`/guilds/${gid}/pages/${page.id}`, { method: 'PUT', body: { title: d.title, slug: d.slug, theme: d.theme, blocks: d.blocks, access: d.access, roleIds: d.roleIds } });
      setDraft(pick(res.page));
      setDirty(false);
      dirtyRef.current = false;
      onSaved(res.page);
      if (!quiet) toast(res.page.published && res.page.changed ? 'Saved as a draft — publish to update the public page.' : 'Saved.', 'ok');
      return true;
    } catch (e) { toast(problemText(e), 'error'); return false; } finally { setSaving(false); }
  }, [gid, page.id, onSaved, toast, dirtyRef]);

  useEffect(() => {
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  /** Runs a publishing action, then shows what the server says the page is now. */
  const act = async (work) => {
    setBusy(true);
    try { await work(); } catch (e) { toast(problemText(e), 'error'); } finally { setBusy(false); }
  };
  const publish = () => act(async () => {
    if (dirty && !(await save({ quiet: true }))) return; // unsaved edits are saved first, so what you see is what goes live
    const res = await api(`/guilds/${gid}/pages/${page.id}/publish`, { method: 'POST' });
    onSaved(res.page);
    toast(res.page.access === 'public' ? 'Published — the public page is updated.' : 'Published — only people with access can open it.', 'ok');
  });
  const unpublish = () => {
    if (!window.confirm('Take this page offline? Visitors will see “Page not found”. Your draft stays here.')) return undefined;
    return act(async () => {
      const res = await api(`/guilds/${gid}/pages/${page.id}/unpublish`, { method: 'POST' });
      onSaved(res.page);
      toast('Unpublished. Your draft is still here.', 'ok');
    });
  };
  const discard = () => {
    if (!window.confirm('Throw away your changes and go back to the published version?')) return undefined;
    return act(async () => {
      const res = await api(`/guilds/${gid}/pages/${page.id}/discard`, { method: 'POST' });
      setDraft(pick(res.page));
      setSelected(null);
      setDirty(false);
      dirtyRef.current = false;
      onSaved(res.page);
      toast('Back to the published version.', 'ok');
    });
  };

  const publicUrl = `${window.location.origin}/s/${gid}/${draft.slug}`;
  const copyLink = () => navigator.clipboard?.writeText(publicUrl).then(() => toast('Link copied.', 'ok'), () => toast(publicUrl, 'info'));
  const selectedBlock = draft.blocks.find((b) => b.id === selected);
  const def = selectedBlock ? BLOCK_TYPES[selectedBlock.type] : null;
  const problemCount = issues.length;
  const blocked = issues.some((i) => i.level === 'error'); // real problems: the server would refuse to publish
  const state = !page.published ? 'draft' : page.changed || dirty ? 'changed' : 'live';
  const canPublish = !busy && !saving && !blocked && (!page.published || page.changed || dirty);

  return (
    <div className="page-editor">
      <div className="flowbar">
        <input className="flow-name" aria-label="Page title" value={draft.title} maxLength={80} onChange={(e) => change({ title: e.target.value })} />
        <label className="slug" title={`Public address: ${publicUrl}`}>
          <span className="muted tiny">/s/…/</span>
          <input aria-label="Web address" value={draft.slug} maxLength={40} spellCheck={false} onChange={(e) => change({ slug: e.target.value.toLowerCase() })} />
        </label>
        <span className={`status-chip ${state}`} role="status" title={state === 'live' ? 'Published — visitors see exactly this' : state === 'changed' ? 'Published, but visitors still see the last published version' : 'Draft — not public yet'}>
          {state === 'live' ? 'Published' : state === 'changed' ? 'Changes not live' : 'Draft'}
        </span>
        <span className={`issue-count ${problemCount ? 'bad' : 'ok'}`}>{problemCount ? `${problemCount} to fix` : '✓ No problems'}</span>
        <span className="spacer" />
        <a className={`btn ghost small ${page.published ? '' : 'disabled'}`} href={page.published ? `/s/${gid}/${page.slug}` : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!page.published} title="Opens the published version">Open live ↗</a>
        <MoreMenu>
          <button className="btn ghost small" onClick={copyLink}>Copy link</button>
          <button className="btn ghost small" disabled={!formsOf(page).length} onClick={() => setShowResponses(true)} title={formsOf(page).length ? 'See what people submitted' : 'Add a form block and save first'}>Responses</button>
          {page.published && (page.changed || dirty) && <button className="btn ghost small" disabled={busy} onClick={discard}>Discard changes</button>}
          {page.published && <button className="btn ghost small danger" disabled={busy} onClick={unpublish}>Unpublish</button>}
        </MoreMenu>
        <button className="btn" disabled={saving || !dirty} onClick={() => save()} title="Saves your draft (Ctrl+S). Visitors see it only after you publish.">{saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
        <button className="btn primary" disabled={!canPublish} onClick={publish} title={blocked ? 'Fix the problems in the list first' : 'Make this the version visitors see'}>{page.published ? 'Publish changes' : 'Publish'}</button>
      </div>

      <div className="page-body" data-pane={pane}>
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
              <button className={`block-row ${selected === null ? 'on' : ''}`} onClick={() => { setSelected(null); setPane('settings'); }}>
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
                  <button className="block-row" onClick={() => { setSelected(b.id); setPane('settings'); }} aria-current={selected === b.id}>
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
                <h3 className="insp-sub">Link preview</h3>
                <FieldList fields={PREVIEW_FIELDS} data={draft.theme} onChange={(k, v) => change({ theme: { ...draft.theme, [k]: v } })} focusRef={focusRef} />
                <LinkPreviewCard page={draft} guild={{ id: gid, name: guild.name, icon: guild.icon }} />
                <p className="help">What Discord shows when this link is pasted. Discord may keep showing an old preview for a while, and pictures only show if the bot’s BASE_URL is a public address.</p>
                <h3 className="insp-sub">Who can open this page</h3>
                <AccessSettings access={draft.access} roleIds={draft.roleIds} roles={roles} onChange={change} />
                <div className="field">
                  <label htmlFor="page-url">Public link</label>
                  <input id="page-url" type="text" readOnly value={publicUrl} onFocus={(e) => e.target.select()} />
                  <div className="help">{page.published ? 'Visitors get the published version.' : 'Not public yet — press Publish (top bar).'}</div>
                </div>
                <p className="tiny muted">Every page shows a footer saying it was made by your admins, not Discord. Visitors log in with Discord before they can fill in a form; the admins see their Discord name and ID with each answer.</p>
              </div>
            </>
          )}
        </aside>
      </div>
      <nav className="pane-tabs" role="tablist" aria-label="Page editor sections">
        {[['blocks', 'Blocks'], ['preview', 'Preview'], ['settings', selectedBlock ? 'Block settings' : 'Page settings']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={pane === id} className={pane === id ? 'on' : ''} onClick={() => setPane(id)}>{label}</button>
        ))}
      </nav>
      {showResponses && <ResponsesDialog gid={gid} page={page} onClose={() => setShowResponses(false)} />}
    </div>
  );
}
