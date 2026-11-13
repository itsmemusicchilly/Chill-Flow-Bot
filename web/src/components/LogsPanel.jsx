import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context.js';

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Two views. “Live” is what is happening now and is kept in memory only. “Saved errors” are the runs that failed — a step ran into an
 * error with nothing on its On error output — which the server keeps, so they are still here after a restart.
 */
export default function LogsPanel({ gid, logs, onClear, onClose, onOpenFlow }) {
  const toast = useToast();
  const [debug, setDebug] = useState(false);
  const [view, setView] = useState('live');
  const [saved, setSaved] = useState(null); // null until loaded, then { errors, keep }
  const box = useRef(null);
  const shown = logs.filter((l) => debug || l.level !== 'debug');
  useEffect(() => { if (view === 'live' && box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown.length, view]);

  const load = useCallback(() => api(`/guilds/${gid}/errors`).then(setSaved).catch(() => {}), [gid]);
  // a new error line in the live log usually means a run just failed: look again a moment later, once it has been written down
  const liveErrors = logs.reduce((n, l) => n + (l.level === 'error' ? 1 : 0), 0);
  useEffect(() => {
    const timer = setTimeout(load, liveErrors ? 600 : 0);
    return () => clearTimeout(timer);
  }, [load, liveErrors]);

  const clearSaved = async () => {
    if (!window.confirm('Delete the saved errors of this server?')) return;
    try { await api(`/guilds/${gid}/errors`, { method: 'DELETE' }); setSaved((s) => ({ ...(s ?? {}), errors: [] })); } catch (e) { toast(e.message, 'error'); }
  };
  const count = saved?.errors?.length ?? 0;

  return (
    <section className="logs" aria-label="Logs">
      <header>
        <b>Logs</b>
        <div className="log-tabs" role="tablist">
          <button role="tab" aria-selected={view === 'live'} className={view === 'live' ? 'on' : ''} onClick={() => setView('live')}>Live</button>
          <button role="tab" aria-selected={view === 'saved'} className={view === 'saved' ? 'on' : ''} onClick={() => setView('saved')}>
            Saved errors{count > 0 && <span className="badge bad">{count}</span>}
          </button>
        </div>
        <span className="tiny muted wide-only">{view === 'live' ? 'Live runs for this server only' : 'Runs that failed — kept after a restart'}</span>
        <span className="spacer" />
        {view === 'live' ? (
          <>
            <label className="tiny"><input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> Show steps</label>
            <button className="btn ghost small" onClick={onClear}>Clear</button>
          </>
        ) : <button className="btn ghost small" disabled={!count} onClick={clearSaved}>Delete saved</button>}
        <button className="icon-btn" aria-label="Hide logs" onClick={onClose}>▾</button>
      </header>
      {view === 'live' ? (
        <div className="log-lines" ref={box} role="log">
          {shown.length === 0 && <div className="muted tiny pad">Nothing yet. Trigger a flow (or press ▶ Run on a Manual trigger) and it shows up here.</div>}
          {shown.map((l) => (
            <div key={l.id} className={`log ${l.level}`}>
              <span className="t">{time(l.ts)}</span>
              <span className="m">{l.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="log-lines saved-errors" role="log" aria-label="Saved errors">
          {saved === null && <div className="muted tiny pad">Loading…</div>}
          {saved !== null && count === 0 && <div className="muted tiny pad">No failed runs. A run counts as failed when a step runs into an error and nothing is connected to its “On error” output.</div>}
          {(saved?.errors ?? []).map((e) => (
            <div key={e.id} className="log error">
              <span className="t">{dateTime(e.at)}</span>
              <span className="m">
                <button type="button" className="link" onClick={() => onOpenFlow?.(e.flowId)} title="Open this flow">{e.flowName}</button>
                {e.nodeLabel ? ` › ${e.nodeLabel}` : ''}: {e.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
