import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context.js';
import Modal from './Modal.jsx';

const ICONS = { twitch: '💜', tiktok: '🎵' };
const NOTES = {
  twitch: 'The streamer approves one permission on Twitch: reading the channel’s follower count. The bot never sees a password.',
  tiktok: 'The creator approves, on TikTok, that this bot may read the follower count. TikTok only lets accounts approved for the bot operator’s TikTok app connect.',
};
const STATUS = {
  ok: { text: 'Connected', cls: 'ok' },
  expired: { text: 'Connect again', cls: 'warn' },
};

/** Connect a creator account (Twitch, TikTok) to this server, so “Followers” triggers can read its count. */
export default function ConnectionsDialog({ gid, accounts, reload, refresh, onClose }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  useEffect(() => { refresh?.().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- always show what is true now (it may have been connected in another tab)

  const connect = async (provider) => {
    setBusy(provider);
    try {
      const { url } = await api(`/guilds/${gid}/accounts/${provider}/start`, { method: 'POST' });
      window.location.assign(url); // the platform's own approval page; it sends the person back here
    } catch (e) { toast(e.message, 'error'); setBusy(''); }
  };
  const disconnect = async (row) => {
    if (!window.confirm(`Disconnect ${row.account} from ${row.label}? Flows that use it will stop until you connect an account again.`)) return;
    setBusy(row.provider);
    try { await api(`/guilds/${gid}/accounts/${row.provider}`, { method: 'DELETE' }); await reload(); toast(`${row.label} disconnected.`); } catch (e) { toast(e.message, 'error'); }
    setBusy('');
  };

  return (
    <Modal title="Connected accounts" onClose={onClose} wide>
      <p className="muted">Connect the Twitch or TikTok account whose followers you want to count. Flows with a <b>Followers</b> trigger use the account connected here — one per platform for this server.</p>
      {accounts === null ? <p>Loading…</p> : (
        <ul className="accounts-list">
          {accounts.map((row) => {
            const status = STATUS[row.status];
            return (
              <li key={row.provider} className="account-row" data-provider={row.provider}>
                <span className="account-icon" aria-hidden="true">{ICONS[row.provider]}</span>
                <div className="account-main">
                  <b>{row.label}</b>
                  {row.connected ? <span className="account-name">{row.account}</span> : null}
                  {status ? <span className={`pill ${status.cls}`}>{status.text}</span> : null}
                  <p className="tiny muted">{row.configured ? NOTES[row.provider] : `The bot operator has not set up ${row.label} yet, so it cannot be connected (they add the ${row.label} keys to the bot’s .env file).`}</p>
                </div>
                <div className="account-actions">
                  {row.configured && <button className="btn small primary" disabled={busy !== ''} onClick={() => connect(row.provider)}>{row.connected ? `Connect another ${row.label}` : `Connect ${row.label}`}</button>}
                  {row.connected && <button className="btn small danger" disabled={busy !== ''} onClick={() => disconnect(row)}>Disconnect</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="tiny muted">YouTube needs no connecting: its triggers read a channel’s public subscriber count (YouTube rounds it above 1,000).</p>
    </Modal>
  );
}
