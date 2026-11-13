import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context.js';
import Modal from './Modal.jsx';

const when = (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** What this flow looked like before each save that changed it. Restoring one only puts it on the canvas: it is live once the person saves. */
export default function VersionsDialog({ gid, flowId, onRestore, onClose }) {
  const toast = useToast();
  const [state, setState] = useState(null); // null while loading, then { versions, keep }
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let alive = true;
    api(`/guilds/${gid}/flows/${flowId}/versions`).then((r) => alive && setState(r)).catch((e) => { if (alive) { toast(e.message, 'error'); setState({ versions: [], keep: 0 }); } });
    return () => { alive = false; };
  }, [gid, flowId, toast]);

  const restore = async (v) => {
    setBusy(v.id);
    try {
      const { version } = await api(`/guilds/${gid}/flows/${flowId}/versions/${v.id}`);
      onRestore(version);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  return (
    <Modal title="Earlier versions" onClose={onClose} wide>
      <p className="muted">
        Each time you save a changed flow, what it looked like before is kept here{state?.keep ? ` — the newest ${state.keep}` : ''}. <b>Restore</b> puts a version on the canvas as an unsaved change:
        look at it, then press <b>Save changes</b> to make it live, or <b>Undo</b> to go back to what you had.
      </p>
      {state === null ? <p>Loading…</p> : state.versions.length === 0 ? <p className="muted">No earlier versions yet. The first one appears the next time you save a change.</p> : (
        <table className="vars-table versions-table">
          <thead><tr><th>Saved</th><th>By</th><th>Name</th><th>Steps</th><th /></tr></thead>
          <tbody>
            {state.versions.map((v) => (
              <tr key={v.id}>
                <td>{when(v.savedAt)}</td><td>{v.savedBy?.name ?? '—'}</td><td>{v.name}</td><td>{v.nodes}</td>
                <td><button className="btn small" disabled={Boolean(busy)} onClick={() => restore(v)}>{busy === v.id ? 'Loading…' : 'Restore'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
