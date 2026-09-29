import { useRef, useState } from 'react';
import Modal from './Modal.jsx';

export default function NewFlowDialog({ templates, onCreate, onClose }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const submit = async (payload) => {
    setBusy(true);
    setError('');
    try { await onCreate(payload); } catch (e) { setError(e.message); setBusy(false); }
  };

  const importFile = async (file) => {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const graph = json.graph ?? json;
      if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) throw new Error('This does not look like an exported flow.');
      await submit({ name: name.trim() || json.name || file.name.replace(/\.json$/i, ''), graph });
    } catch (e) { setError(e.message); }
  };

  return (
    <Modal title="New flow" onClose={onClose} wide>
      <div className="field">
        <label htmlFor="nf-name">Name</label>
        <input id="nf-name" type="text" value={name} maxLength={60} placeholder="Optional — templates have their own name" onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <h3>Start from a template</h3>
      <div className="template-grid">
        {templates.map((t) => (
          <button key={t.id} className="template" disabled={busy} onClick={() => submit({ templateId: t.id, name: name.trim() || undefined })}>
            <b>{t.name}</b>
            <span>{t.description}</span>
          </button>
        ))}
        <button className="template blank" disabled={busy} onClick={() => submit({ name: name.trim() || 'New flow', graph: { nodes: [], edges: [] } })}>
          <b>Blank flow</b>
          <span>Start from an empty canvas.</span>
        </button>
      </div>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>Import from file…</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => importFile(e.target.files?.[0])} />
        <span className="tiny muted">New flows start switched off so you can finish setting them up.</span>
      </div>
      {error && <div className="banner bad" role="alert">{error}</div>}
    </Modal>
  );
}
