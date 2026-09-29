import { useState } from 'react';
import { PAGE_TEMPLATES } from '@shared/page-templates.js';
import Modal from './Modal.jsx';

export default function NewPageDialog({ onCreate, onClose }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choose = async (templateId) => {
    setBusy(true);
    setError('');
    try { await onCreate({ templateId, ...(title.trim() ? { title: title.trim() } : {}) }); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Modal title="New page" onClose={onClose} wide>
      <div className="field">
        <label htmlFor="np-title">Title</label>
        <input id="np-title" type="text" value={title} maxLength={80} placeholder="Optional — templates have their own title" onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>
      <h3>Start from a template</h3>
      <div className="template-grid">
        {PAGE_TEMPLATES.map((t) => (
          <button key={t.id} className={`template ${t.id === 'blank' ? 'blank' : ''}`} disabled={busy} onClick={() => choose(t.id)}>
            <b>{t.name}</b>
            <span>{t.description}</span>
          </button>
        ))}
      </div>
      <p className="tiny muted">New pages are not public until you switch them on. Forms need people to log in with Discord.</p>
      {error && <div className="banner bad" role="alert">{error}</div>}
    </Modal>
  );
}
