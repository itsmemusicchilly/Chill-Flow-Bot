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

/** “just now”, “5 minutes ago”, “3 hours ago” */
export function ago(at, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** Connect creator accounts (Twitch, TikTok) to this server, so “Followers” triggers can read their count. Several of each are allowed. */
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
  const disconnect = async (group, account) => {
    if (!window.confirm(`Disconnect ${account.name} from ${group.label}? Flows that use it will stop until you connect it again.`)) return;
    setBusy(`${group.provider}|${account.id}`);
    try { await api(`/guilds/${gid}/accounts/${group.provider}/${encodeURIComponent(account.id)}`, { method: 'DELETE' }); await reload(); toast(`${account.name} disconnected.`); } catch (e) { toast(e.message, 'error'); }
    setBusy('');
  };
  const check = async (group, account) => {
    setBusy(`${group.provider}|${account.id}`);
    try { await api(`/guilds/${gid}/accounts/${group.provider}/${encodeURIComponent(account.id)}/check`, { method: 'POST' }); await reload(); } catch (e) { toast(e.message, 'error'); await reload().catch(() => {}); }
    setBusy('');
  };

  return (
    <Modal title="Connected accounts" onClose={onClose} wide>
      <p className="muted">Connect the Twitch or TikTok accounts whose followers you want to count. A <b>Followers</b> trigger uses the first account that works, or the one you pick in the trigger.</p>
      {accounts === null ? <p>Loading…</p> : accounts.map((group) => (
        <section key={group.provider} className="account-group" data-provider={group.provider} aria-label={group.label}>
          <header className="account-head">
            <span className="account-icon" aria-hidden="true">{ICONS[group.provider]}</span>
            <b>{group.label}</b>
            {group.configured && <button className="btn small primary" disabled={busy !== ''} onClick={() => connect(group.provider)}>{group.accounts.length ? `Connect another ${group.label}` : `Connect ${group.label}`}</button>}
          </header>
          <p className="tiny muted">{group.configured ? NOTES[group.provider] : `The bot operator has not set up ${group.label} yet, so it cannot be connected (they add the ${group.label} keys to the bot’s .env file).`}</p>
          {group.configured && group.accounts.length === 0 && <p className="tiny muted">No {group.label} account is connected.</p>}
          <ul className="accounts-list">
            {group.accounts.map((account) => {
              const status = STATUS[account.status];
              const working = busy === `${group.provider}|${account.id}`;
              return (
                <li key={account.id} className="account-row" data-account={account.id}>
                  <div className="account-main">
                    <span className="account-name">{account.name}</span>
                    {status ? <span className={`pill ${status.cls}`}>{status.text}</span> : null}
                    <p className="tiny muted account-count">
                      {account.count === null ? 'Not checked yet — the first check happens within a minute of a flow using it.' : `${account.count.toLocaleString('en-US')} followers · checked ${ago(account.checkedAt)}`}
                    </p>
                  </div>
                  <div className="account-actions">
                    {account.status === 'ok' && <button className="btn small" disabled={busy !== ''} onClick={() => check(group, account)}>{working ? 'Checking…' : 'Check now'}</button>}
                    <button className="btn small danger" disabled={busy !== ''} onClick={() => disconnect(group, account)}>Disconnect</button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="tiny muted">YouTube needs no connecting: its triggers read a channel’s public subscriber count (YouTube rounds it above 1,000).</p>
    </Modal>
  );
}
