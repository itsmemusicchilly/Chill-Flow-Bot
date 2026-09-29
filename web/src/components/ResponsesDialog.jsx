import { useCallback, useEffect, useState } from 'react';
import { formsOf } from '@shared/blocks.js';
import { answerText } from '@shared/forms.js';
import { api } from '../api.js';
import { useToast } from '../context.js';
import Modal from './Modal.jsx';

const PAGE_SIZE = 50;

export default function ResponsesDialog({ gid, page, onClose }) {
  const toast = useToast();
  const forms = formsOf(page);
  const [blockId, setBlockId] = useState(forms[0]?.blockId ?? '');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const form = page.blocks.find((b) => b.id === blockId && b.type === 'form');
  const questions = form?.data.fields ?? [];
  const base = `/guilds/${gid}/pages/${page.id}`;

  const load = useCallback(async (offset) => {
    if (!blockId) return;
    setLoading(true);
    try {
      const r = await api(`${base}/responses?form=${encodeURIComponent(blockId)}&limit=${PAGE_SIZE}&offset=${offset}`);
      setRows((cur) => (offset === 0 ? r.rows : [...cur, ...r.rows]));
      setTotal(r.total);
    } catch (e) { toast(e.message, 'error'); } finally { setLoading(false); }
  }, [base, blockId, toast]);

  useEffect(() => { setRows([]); load(0); }, [load]);

  const remove = async (r) => {
    if (!window.confirm('Delete this response? This cannot be undone.')) return;
    try {
      await api(`${base}/responses/${r.id}`, { method: 'DELETE' });
      setRows((cur) => cur.filter((x) => x.id !== r.id));
      setTotal((t) => t - 1);
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <Modal title={`Responses — ${page.title}`} onClose={onClose} wide>
      {forms.length === 0 ? <p className="muted">This page has no forms yet.</p> : (
        <>
          <div className="row">
            {forms.length > 1 && (
              <select aria-label="Form" value={blockId} onChange={(e) => setBlockId(e.target.value)}>
                {forms.map((f) => <option key={f.blockId} value={f.blockId}>{f.title}</option>)}
              </select>
            )}
            <span className="muted">{total} {total === 1 ? 'response' : 'responses'}</span>
            <span className="spacer" />
            <a className="btn" href={`/api${base}/responses.csv?form=${encodeURIComponent(blockId)}`} download>Download CSV</a>
          </div>
          {total === 0 && !loading && <p className="muted">Nothing yet. Responses appear here after someone submits the published form (if “Save responses” is on).</p>}
          <div className="responses">
            {rows.map((r) => (
              <article key={r.id} className="response">
                <header>
                  <b>{r.userName || 'Receipt only'}</b> <span className="mono muted">{r.userId}</span>
                  <span className="spacer" />
                  <time className="tiny muted" dateTime={new Date(r.createdAt).toISOString()}>{new Date(r.createdAt).toLocaleString()}</time>
                  <button className="icon-btn danger" aria-label="Delete response" onClick={() => remove(r)}>✕</button>
                </header>
                {Object.keys(r.answers).length === 0
                  ? <p className="tiny muted">No answers were stored for this response (saving is off for this form).</p>
                  : <dl>{questions.map((q) => <div key={q.id}><dt>{q.label}</dt><dd>{answerText(r.answers[q.id]) || '—'}</dd></div>)}</dl>}
              </article>
            ))}
          </div>
          {rows.length < total && <button className="btn" disabled={loading} onClick={() => load(rows.length)}>Load more</button>}
        </>
      )}
    </Modal>
  );
}
