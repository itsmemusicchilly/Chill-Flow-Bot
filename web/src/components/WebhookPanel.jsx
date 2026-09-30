import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useEditor, useToast } from '../context.js';

/** Under a Webhook Received trigger's settings: its secret address, to copy into Zapier, IFTTT, StreamElements … (made on first use, replaceable). */
export default function WebhookPanel({ node }) {
  const { gid, flowId, dirty } = useEditor();
  const toast = useToast();
  const [hook, setHook] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dirty || !gid) return undefined; // unsaved changes: the trigger may not exist on the server yet
    let alive = true;
    setError('');
    api(`/guilds/${gid}/flows/${flowId}/webhook`, { method: 'POST', body: { nodeId: node.id } })
      .then((h) => alive && setHook(h))
      .catch((e) => { if (alive) { setHook(null); setError(e.message); } });
    return () => { alive = false; };
  }, [gid, flowId, node.id, dirty]);

  const copy = () => navigator.clipboard?.writeText(hook.url).then(() => toast('Address copied.', 'ok'), () => toast(hook.url, 'info'));
  const renew = async () => {
    if (!window.confirm('Make a new address? The old one stops working at once, so anything that still uses it must be updated.')) return;
    setBusy(true);
    try { setHook(await api(`/guilds/${gid}/flows/${flowId}/webhook`, { method: 'POST', body: { nodeId: node.id, renew: true } })); toast('New address made. The old one no longer works.', 'ok'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="field webhook-panel">
      <label htmlFor="webhook-url">Secret address</label>
      {hook ? (
        <>
          <div className="idfield">
            <input id="webhook-url" type="text" readOnly value={hook.url} onFocus={(e) => e.target.select()} spellCheck={false} />
            <button type="button" className="btn small" onClick={copy}>Copy</button>
          </div>
          <div className="help">
            Anyone who has this address can start this flow, so treat it like a password. Send it a <b>POST</b> with JSON, form fields or text; use <code>{'{{webhook.body.name}}'}</code> for a field called “name”.
            {hook.lastAt ? ` Last used ${new Date(hook.lastAt).toLocaleString()}.` : ' Not used yet.'} The flow must be switched on.
          </div>
          <div><button type="button" className="btn small danger" disabled={busy} onClick={renew}>Make a new address</button></div>
        </>
      ) : (
        <div className="help">{dirty ? 'Save the flow to get this trigger’s address.' : error || 'Getting the address…'}</div>
      )}
    </div>
  );
}
