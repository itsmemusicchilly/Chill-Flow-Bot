import { useEffect, useRef, useState } from 'react';
import { useToast } from '../context.js';
import { ACCEPT, formatBytes } from '../uploads/useUploads.js';
import Modal from './Modal.jsx';

const usedIn = (u) => [...u.uses.pages.map((p) => `page “${p.title}”`), ...u.uses.flows.map((f) => `flow “${f.name}”`)];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The server's picture library. With `onPick` it is a chooser (used by image fields); without, it only manages pictures.
 * `library` is the result of useUploads().
 */
export default function ImageLibrary({ library, meta, limits, current, onPick, onClose }) {
  const toast = useToast();
  const { items, usage, error, progress, upload, remove, refresh, clearProgress } = library;
  const [drag, setDrag] = useState(false);
  const [working, setWorking] = useState(false);
  const input = useRef(null);
  const picking = typeof onPick === 'function';
  useEffect(() => { refresh(); }, [refresh]); // where a picture is used changes as pages and flows are saved: look again each time the library opens

  const send = async (fileList) => {
    const files = [...fileList];
    if (!files.length || working) return;
    setWorking(true);
    try {
      const stored = await upload(files);
      // Opened to choose a picture and uploaded exactly one: use it straight away.
      if (picking && files.length === 1 && stored.length === 1) onPick(stored[0].ref);
    } finally { setWorking(false); if (input.current) input.current.value = ''; }
  };

  const del = async (u) => {
    const places = usedIn(u);
    const text = places.length
      ? `Delete “${u.name}”?\n\nIt is used in ${places.join(', ')}. Those will lose the picture.`
      : `Delete “${u.name}”? This cannot be undone.`;
    if (!window.confirm(text)) return;
    try { await remove(u); toast('Picture deleted.', 'ok'); } catch (e) { toast(e.message, 'error'); }
  };

  const onDrop = (e) => { e.preventDefault(); setDrag(false); send(e.dataTransfer?.files ?? []); };
  const cap = [
    limits.uploadsPerGuild ? `of ${limits.uploadsPerGuild} pictures` : '',
    limits.storageBytesPerGuild ? `of ${formatBytes(limits.storageBytesPerGuild)}` : '',
  ].filter(Boolean);

  return (
    <Modal title={picking ? 'Choose a picture' : 'Pictures'} onClose={onClose} wide>
      {!meta.available && <div className="banner bad" role="alert">Picture uploads are not available on this server. You can still paste an https link.</div>}
      {meta.available && !meta.publicBase && (
        <p className="tiny muted">Uploaded pictures work on your pages. To show them in Discord messages too, the bot’s <span className="mono">BASE_URL</span> must be a public address (for example https://bot.example.com), because Discord has to download them.</p>
      )}

      <div
        className={`dropzone ${drag ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
      >
        <label className={`btn primary ${!meta.available || working ? 'disabled' : ''}`}>
          {working ? 'Uploading…' : 'Upload pictures…'}
          <input
            ref={input} type="file" className="visually-hidden" aria-label="Upload pictures" multiple
            accept={ACCEPT.join(',')} disabled={!meta.available || working} onChange={(e) => send(e.target.files)}
          />
        </label>
        <span className="muted tiny">or drop files here · PNG, JPEG, WebP or GIF{meta.maxBytes ? ` · up to ${formatBytes(meta.maxBytes)} each` : ''}. Photos are cleaned up: location data is removed and big ones are shrunk.</span>
      </div>

      {progress.length > 0 && (
        <ul className="upload-progress" aria-live="polite">
          {progress.map((r) => (
            <li key={r.key} className={r.state}>
              <span aria-hidden="true">{r.state === 'done' ? '✓' : r.state === 'error' ? '✕' : '…'}</span>
              <span className="up-name">{r.name}</span>
              {r.message && <span className="tiny">{r.message}</span>}
            </li>
          ))}
          {!working && <li><button type="button" className="linkbtn" onClick={clearProgress}>Clear</button></li>}
        </ul>
      )}

      {error && <div className="banner bad" role="alert">Could not load your pictures: {error}</div>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted">No pictures yet. Upload one above.</p>}
      {items?.length > 0 && (
        <>
          <p className="tiny muted" data-testid="usage">
            {plural(usage.count, 'picture', 'pictures')} · {formatBytes(usage.bytes)}{cap.length ? ` (${cap.join(', ')})` : ''}
          </p>
          <ul className="img-grid">
            {items.map((u) => {
              const places = usedIn(u);
              const thumb = <img src={u.url} alt="" loading="lazy" width={u.width} height={u.height} />;
              return (
                <li key={u.id} className={`img-tile ${current === u.ref ? 'on' : ''}`} data-id={u.id}>
                  {picking
                    ? <button type="button" className="img-thumb-btn" aria-label={`Use ${u.name}`} onClick={() => onPick(u.ref)}>{thumb}</button>
                    : <div className="img-thumb-btn static">{thumb}</div>}
                  <div className="img-meta">
                    <b title={u.name}>{u.name}</b>
                    <span className="tiny muted">{u.width}×{u.height} · {formatBytes(u.bytes)}{u.animated ? ' · animated' : ''}</span>
                    <span className="tiny muted" title={places.join(', ')}>{places.length ? `Used in ${plural(places.length, 'place', 'places')}` : 'Not used'}</span>
                  </div>
                  <div className="img-actions">
                    {picking && <button type="button" className="btn small primary" onClick={() => onPick(u.ref)}>Use</button>}
                    <button type="button" className="icon-btn danger" title="Delete" aria-label={`Delete ${u.name}`} onClick={() => del(u)}>🗑</button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Modal>
  );
}
