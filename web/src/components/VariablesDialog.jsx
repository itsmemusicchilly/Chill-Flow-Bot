import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context.js';
import Modal from './Modal.jsx';

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };

export default function VariablesDialog({ gid, onClose }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState({ scope: 'guild', scopeId: '', name: '', value: '' });

  const load = useCallback(() => api(`/guilds/${gid}/variables`).then(setRows).catch((e) => toast(e.message, 'error')), [gid, toast]);
  useEffect(() => { load(); }, [load]);

  const remove = async (r) => {
    await api(`/guilds/${gid}/variables?${new URLSearchParams({ scope: r.scope, scopeId: r.scopeId, name: r.name })}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
    load();
  };
  const add = async (e) => {
    e.preventDefault();
    try {
      await api(`/guilds/${gid}/variables`, { method: 'PUT', body: { scope: form.scope, scopeId: form.scopeId.trim(), name: form.name.trim(), value: parse(form.value) } });
      setForm({ ...form, name: '', value: '' });
      load();
    } catch (err) { toast(err.message, 'error'); }
  };

  return (
    <Modal title="Remembered variables" onClose={onClose} wide>
      <p className="muted">Variables saved by <b>Set Variable</b> nodes with the “Server” or “Per user” scope. Only this server can see them.</p>
      {rows === null ? <p>Loading…</p> : rows.length === 0 ? <p className="muted">Nothing stored yet.</p> : (
        <table className="vars-table">
          <thead><tr><th>Scope</th><th>User</th><th>Name</th><th>Value</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.scope}|${r.scopeId}|${r.name}`}>
                <td>{r.scope}</td><td className="mono">{r.scopeId || '—'}</td><td className="mono">{r.name}</td>
                <td className="mono value">{show(r.value)}</td>
                <td><button className="icon-btn danger" aria-label={`Delete ${r.name}`} onClick={() => remove(r)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="var-form" onSubmit={add}>
        <select aria-label="Scope" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
          <option value="guild">Server</option><option value="user">Per user</option>
        </select>
        {form.scope === 'user' && <input aria-label="User ID" placeholder="User ID" value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} required />}
        <input aria-label="Variable name" placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input aria-label="Value" placeholder="value (text, number or JSON)" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} required />
        <button className="btn" type="submit">Set</button>
      </form>
    </Modal>
  );
}
