import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accountFlagsFrom } from '@shared/platforms.js';
import { api, takeConnectResult } from '../api.js';
import { ImagesContext, useToast } from '../context.js';
import FlowWorkspace from './FlowWorkspace.jsx';
import ImageLibrary from './ImageLibrary.jsx';
import LogsPanel from './LogsPanel.jsx';
import MoreMenu from './MoreMenu.jsx';
import NewFlowDialog from './NewFlowDialog.jsx';
import NewPageDialog from './NewPageDialog.jsx';
import PageEditor from './PageEditor.jsx';
import PagesList from './PagesList.jsx';
import Palette from './Palette.jsx';
import ConnectionsDialog from './ConnectionsDialog.jsx';
import VariablesDialog from './VariablesDialog.jsx';
import { matches, PHONE } from '../hooks/useMediaQuery.js';
import { usePages } from '../pages/usePages.js';
import { useUploads } from '../uploads/useUploads.js';

const MAX_LOGS = 400;

export default function Editor({ me, guild, flowId, pageId, navigate, onLogout }) {
  const gid = guild.id;
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [channels, setChannels] = useState([]);
  const [roles, setRoles] = useState([]);
  const [flows, setFlows] = useState(null);
  const [flow, setFlow] = useState(null);
  const [tab, setTab] = useState(pageId ? 'pages' : 'flows');
  const [dialog, setDialog] = useState(null); // 'new' | 'newpage' | 'vars' | 'accounts'
  const [accounts, setAccounts] = useState(null); // the creator accounts (Twitch, TikTok) connected to this server — null until loaded
  const [showLogs, setShowLogs] = useState(() => !matches(PHONE)); // logs take a third of a phone screen: start closed there
  const [navOpen, setNavOpen] = useState(() => matches(PHONE) && !flowId && !pageId); // on a phone the sidebar is a drawer; open it when there is nothing else to show

  const [logs, setLogs] = useState([]);
  const [flash, setFlash] = useState({});
  const [loadError, setLoadError] = useState('');
  const apiRef = useRef(null);
  const dirtyRef = useRef(false);
  const flowIdRef = useRef(flowId);
  flowIdRef.current = flowId;
  const confirmLeave = () => !dirtyRef.current || window.confirm('You have unsaved changes. Discard them?');
  const pagesApi = usePages({ gid, pageId, navigate, confirmLeave, dirtyRef });
  const uploads = useUploads(gid, me.meta.uploads.maxBytes);
  const [library, setLibrary] = useState(null); // null (closed) | { onPick?, current? }
  const imagesCtx = useMemo(() => ({
    gid, available: me.meta.uploads.available, publicBase: me.meta.uploads.publicBase, ids: uploads.ids,
    openLibrary: (opts = {}) => setLibrary(opts),
  }), [gid, me.meta.uploads.available, me.meta.uploads.publicBase, uploads.ids]);
  useEffect(() => { if (pageId) setTab('pages'); else if (flowId) setTab('flows'); }, [pageId, flowId]);
  useEffect(() => { if (pageId || flowId) setNavOpen(false); }, [pageId, flowId]);

  // ---- connected accounts: which ones work decides whether a Followers trigger can run ------------
  const reloadAccounts = useCallback(async () => {
    const rows = await api(`/guilds/${gid}/accounts`);
    setAccounts(rows);
    return rows;
  }, [gid]);
  useEffect(() => { reloadAccounts().catch(() => setAccounts([])); }, [reloadAccounts]);
  /** After connecting or disconnecting here: the flows' issue counts in the list depend on which accounts work. */
  const accountsChanged = useCallback(async () => {
    await reloadAccounts();
    api(`/guilds/${gid}/flows`).then(setFlows).catch(() => {});
  }, [gid, reloadAccounts]);
  const accountFlags = useMemo(() => (accounts ? accountFlagsFrom(accounts.flatMap((g) => g.accounts.map((a) => ({ provider: g.provider, id: a.id, status: a.status })))) : undefined), [accounts]);
  // coming back from Twitch / TikTok: say how it went, once, and show the accounts
  useEffect(() => {
    const back = takeConnectResult();
    if (!back) return;
    toast(back.message, back.error ? 'error' : undefined);
    setDialog('accounts');
  }, [toast]);

  // ---- initial load ---------------------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    Promise.all([api(`/guilds/${gid}`), api(`/guilds/${gid}/channels`), api(`/guilds/${gid}/roles`), api(`/guilds/${gid}/flows`)])
      .then(([i, c, r, f]) => { if (alive) { setInfo(i); setChannels(c); setRoles(r); setFlows(f); } })
      .catch((e) => alive && setLoadError(e.message));
    return () => { alive = false; };
  }, [gid]);

  // ---- open the flow named in the URL ---------------------------------------------------------
  useEffect(() => {
    if (!flows) return undefined;
    if (!flowId) { setFlow(null); return undefined; }
    if (flow?.id === flowId) return undefined;
    let alive = true;
    api(`/guilds/${gid}/flows/${flowId}`)
      .then((r) => alive && setFlow(r.flow))
      .catch((e) => { if (alive) { toast(e.message, 'error'); navigate(gid); } });
    return () => { alive = false; };
  }, [flowId, flows, gid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live logs (also drives the "flashing node" effect) --------------------------------------
  useEffect(() => {
    let alive = true;
    api(`/guilds/${gid}/logs`).then((rows) => alive && setLogs(rows)).catch(() => {});
    const es = new EventSource(`/api/guilds/${gid}/logs/stream`);
    es.onmessage = (ev) => {
      const entry = JSON.parse(ev.data);
      setLogs((l) => [...l.slice(-(MAX_LOGS - 1)), entry]);
      if (entry.nodeId && entry.flowId === flowIdRef.current) {
        setFlash((f) => ({ ...f, [entry.nodeId]: entry.id }));
        setTimeout(() => setFlash((f) => { if (f[entry.nodeId] !== entry.id) return f; const { [entry.nodeId]: _gone, ...rest } = f; return rest; }), 1200);
      }
    };
    return () => { alive = false; es.close(); };
  }, [gid]);

  const accountChoices = useMemo(() => Object.fromEntries((accounts ?? []).map((g) => [g.provider, g.accounts.map((a) => ({ id: a.id, name: a.name }))])), [accounts]);
  const guildData = useMemo(() => ({ channels, roles, forms: pagesApi.forms, accounts: accountChoices }), [channels, roles, pagesApi.forms, accountChoices]);

  const openFlow = (id) => { setNavOpen(false); if (id !== flowId && confirmLeave()) navigate(gid, id); };

  const summaryOf = (f) => ({ id: f.id, name: f.name, enabled: f.enabled, updatedAt: f.updatedAt, updatedBy: f.updatedBy, nodes: f.nodes ?? f.graph?.nodes.length, issues: f.issues?.filter?.((i) => i.level === 'error').length ?? f.issues });
  const onSaved = useCallback((saved, sync) => {
    setFlow(saved);
    setFlows((list) => list.map((f) => (f.id === saved.id ? summaryOf({ ...saved, issues: saved.issues }) : f)));
    if (sync) setInfo((i) => ({ ...i, commandSync: { ...(i?.commandSync || {}), ...sync } }));
  }, []);

  const onToggle = async (enabled) => {
    try {
      const res = await api(`/guilds/${gid}/flows/${flow.id}`, { method: 'PUT', body: { enabled } });
      setFlow((f) => ({ ...f, enabled: res.flow.enabled }));
      setFlows((list) => list.map((f) => (f.id === flow.id ? { ...f, enabled: res.flow.enabled } : f)));
      setInfo((i) => ({ ...i, commandSync: { ...(i?.commandSync || {}), ...res.sync } }));
      toast(enabled ? 'Flow switched on.' : 'Flow switched off.', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };

  const createFlow = async (payload) => {
    const res = await api(`/guilds/${gid}/flows`, { method: 'POST', body: payload });
    setFlows((l) => [...l, summaryOf(res.flow)]);
    setFlow(res.flow);
    setDialog(null);
    navigate(gid, res.flow.id);
    toast('Flow created. Fill in the highlighted fields, then switch it on.', 'ok');
  };

  const removeFlow = async (f) => {
    if (!window.confirm(`Delete “${f.name}”? This cannot be undone.`)) return;
    try {
      const res = await api(`/guilds/${gid}/flows/${f.id}`, { method: 'DELETE' });
      setFlows((l) => l.filter((x) => x.id !== f.id));
      setInfo((i) => ({ ...i, commandSync: { ...(i?.commandSync || {}), ...res.sync } }));
      if (f.id === flowId) { dirtyRef.current = false; setFlow(null); navigate(gid); }
    } catch (e) { toast(e.message, 'error'); }
  };

  const duplicateFlow = async (f) => {
    try {
      const res = await api(`/guilds/${gid}/flows/${f.id}/duplicate`, { method: 'POST' });
      setFlows((l) => [...l, summaryOf(res.flow)]);
      openFlow(res.flow.id);
    } catch (e) { toast(e.message, 'error'); }
  };

  if (loadError) return <div className="splash">Could not open this server: {loadError} <button className="btn" onClick={() => navigate(null)}>Back</button></div>;
  if (!info || !flows || !pagesApi.pages) return <div className="splash">Loading server…</div>;

  const sync = info.commandSync;
  return (
    <ImagesContext.Provider value={imagesCtx}>
    <div className="app">
      <header className="topbar">
        <button className="icon-btn nav-toggle phone-only" aria-label="Flows, pages and nodes" aria-expanded={navOpen} onClick={() => setNavOpen((o) => !o)}>☰</button>
        <button className="icon-btn" aria-label="Back to servers" title="All servers" onClick={() => confirmLeave() && navigate(null)}>←</button>
        {guild.icon ? <img className="guild-icon sm" src={guild.icon} alt="" width="26" height="26" /> : <span className="guild-icon sm fallback" aria-hidden="true">{guild.name[0]}</span>}
        <b className="guild-title">{guild.name}</b>
        <span className="spacer" />
        <button className="btn ghost small wide-only" onClick={() => setDialog('accounts')}>Accounts</button>
        <button className="btn ghost small wide-only" onClick={() => setDialog('vars')}>Variables</button>
        <button className="btn ghost small wide-only" onClick={() => setLibrary({})}>Pictures</button>
        <button className="btn ghost small wide-only" onClick={() => setShowLogs((s) => !s)} aria-pressed={showLogs}>{showLogs ? 'Hide logs' : 'Show logs'}</button>
        <MoreMenu className="phone-only" label="⋯" ariaLabel="More actions">
          <button className="btn ghost small" onClick={() => setDialog('accounts')}>Accounts</button>
          <button className="btn ghost small" onClick={() => setDialog('vars')}>Variables</button>
          <button className="btn ghost small" onClick={() => setLibrary({})}>Pictures</button>
          <button className="btn ghost small" onClick={() => setShowLogs((s) => !s)}>{showLogs ? 'Hide logs' : 'Show logs'}</button>
          <button className="btn ghost small" onClick={onLogout}>Log out</button>
        </MoreMenu>
        <img className="avatar wide-only" src={me.user.avatar} alt="" width="26" height="26" />
        <button className="btn ghost small wide-only" onClick={onLogout}>Log out</button>
      </header>

      {sync && sync.ok === false && <div className="banner bad" role="alert">Slash commands could not be updated: {sync.error}. Other parts of your flows keep working.</div>}

      <div className="main">
        {navOpen && <button type="button" className="scrim" aria-label="Close menu" onClick={() => setNavOpen(false)} />}
        <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'flows'} className={tab === 'flows' ? 'on' : ''} onClick={() => setTab('flows')}>Flows</button>
            <button role="tab" aria-selected={tab === 'pages'} className={tab === 'pages' ? 'on' : ''} onClick={() => setTab('pages')}>Pages</button>
            <button role="tab" aria-selected={tab === 'nodes'} className={tab === 'nodes' ? 'on' : ''} onClick={() => setTab('nodes')} disabled={!flow || Boolean(pageId)}>Nodes</button>
          </div>
          {tab === 'pages' ? (
            <PagesList
              pages={pagesApi.pages} pageId={pageId} limit={me.meta.limits.pagesPerGuild}
              onOpen={(id) => { setNavOpen(false); pagesApi.openPage(id); }} onNew={() => { setNavOpen(false); setDialog('newpage'); }} onDuplicate={pagesApi.duplicatePage} onRemove={pagesApi.removePage}
            />
          ) : tab === 'flows' ? (
            <div className="flow-list">
              <button className="btn primary block" onClick={() => { setNavOpen(false); setDialog('new'); }}>+ New flow</button>
              {flows.length === 0 && <p className="muted tiny">No flows yet. Start from a template — it is the quickest way to see how things connect.</p>}
              {flows.map((f) => (
                <div key={f.id} className={`flow-item ${f.id === flowId ? 'active' : ''}`}>
                  <button className="flow-open" onClick={() => openFlow(f.id)}>
                    <span className={`dot ${f.enabled ? 'on' : ''}`} title={f.enabled ? 'On' : 'Off'} />
                    <span className="flow-title">{f.name}</span>
                    {f.issues > 0 && <span className="badge bad" title={`${f.issues} thing(s) to fix`}>{f.issues}</span>}
                  </button>
                  <span className="flow-actions">
                    <button className="icon-btn" title="Duplicate" aria-label={`Duplicate ${f.name}`} onClick={() => duplicateFlow(f)}>⧉</button>
                    <button className="icon-btn danger" title="Delete" aria-label={`Delete ${f.name}`} onClick={() => removeFlow(f)}>🗑</button>
                  </span>
                </div>
              ))}
              <p className="tiny muted">{flows.length}{me.meta.limits.flowsPerGuild ? `/${me.meta.limits.flowsPerGuild}` : ''} {flows.length === 1 ? 'flow' : 'flows'}</p>
            </div>
          ) : (
            <Palette intents={me.meta.intents} integrations={me.meta.integrations} onAdd={(type) => { apiRef.current?.addNode(type); setNavOpen(false); }} />
          )}
        </aside>

        <div className="stage">
          {pageId && pagesApi.page && pagesApi.page.id === pageId ? (
            <PageEditor key={pagesApi.page.id} gid={gid} guild={guild} roles={roles} page={pagesApi.page} dirtyRef={dirtyRef} onSaved={pagesApi.onPageSaved} />
          ) : pageId ? (
            <div className="empty-stage"><p className="muted">Loading page…</p></div>
          ) : flow && flow.id === flowId ? (
            <ReactFlowProvider key={flow.id}>
              <FlowWorkspace
                gid={gid} flow={flow} meta={me.meta} accounts={accountFlags} guildData={guildData} flash={flash}
                apiRef={apiRef} dirtyRef={dirtyRef} onSaved={onSaved} onToggle={onToggle}
              />
            </ReactFlowProvider>
          ) : (
            <div className="empty-stage">
              <h2>{flows.length ? 'Pick a flow' : 'Build your first flow'}</h2>
              <p className="muted">A flow starts with a <b>trigger</b> (a slash command or a server event) and continues with <b>actions</b>. Buttons you add to a message become their own branches.</p>
              <button className="btn primary big" onClick={() => setDialog('new')}>Create a flow</button>
            </div>
          )}
          {showLogs && <LogsPanel logs={logs} onClear={() => setLogs([])} onClose={() => setShowLogs(false)} />}
        </div>
      </div>

      {dialog === 'new' && <NewFlowDialog templates={me.meta.templates} onCreate={createFlow} onClose={() => setDialog(null)} />}
      {dialog === 'newpage' && <NewPageDialog onCreate={async (payload) => { await pagesApi.createPage(payload); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog === 'vars' && <VariablesDialog gid={gid} onClose={() => setDialog(null)} />}
      {dialog === 'accounts' && <ConnectionsDialog gid={gid} accounts={accounts} reload={accountsChanged} refresh={reloadAccounts} onClose={() => setDialog(null)} />}
      {library && (
        <ImageLibrary
          library={uploads} meta={me.meta.uploads} limits={me.meta.limits} current={library.current}
          onPick={library.onPick ? (ref) => { library.onPick(ref); setLibrary(null); } : undefined}
          onClose={() => setLibrary(null)}
        />
      )}
    </div>
    </ImagesContext.Provider>
  );
}
