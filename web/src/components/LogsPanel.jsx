import { useEffect, useRef, useState } from 'react';

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function LogsPanel({ logs, onClear, onClose }) {
  const [debug, setDebug] = useState(false);
  const box = useRef(null);
  const shown = logs.filter((l) => debug || l.level !== 'debug');
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown.length]);
  return (
    <section className="logs" aria-label="Logs">
      <header>
        <b>Logs</b>
        <span className="tiny muted">Live runs for this server only</span>
        <span className="spacer" />
        <label className="tiny"><input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> Show steps</label>
        <button className="btn ghost small" onClick={onClear}>Clear</button>
        <button className="icon-btn" aria-label="Hide logs" onClick={onClose}>▾</button>
      </header>
      <div className="log-lines" ref={box} role="log">
        {shown.length === 0 && <div className="muted tiny pad">Nothing yet. Trigger a flow (or press ▶ Run on a Manual trigger) and it shows up here.</div>}
        {shown.map((l) => (
          <div key={l.id} className={`log ${l.level}`}>
            <span className="t">{time(l.ts)}</span>
            <span className="m">{l.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
