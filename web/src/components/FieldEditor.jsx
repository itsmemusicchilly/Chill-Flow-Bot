import { useState } from 'react';
import { isVisible } from '@shared/catalog.js';
import { uploadIdOf, uploadPath } from '@shared/urls.js';
import { namesFor, useEditor, useImages } from '../context.js';

/** Renders every visible field of a node (or list item) and reports changes as (key, value). */
export function FieldList({ fields, data, onChange, focusRef }) {
  return fields.filter((f) => isVisible(f, data)).map((f) => (
    <FieldEditor key={f.key} field={f} data={data} value={data[f.key]} onChange={(v) => onChange(f.key, v)} focusRef={focusRef} />
  ));
}

/** Remember the last focused text field so a variable chip can insert `{{…}}` at the caret. */
const track = (focusRef, apply) => (e) => { if (focusRef) focusRef.current = { el: e.target, apply }; };

function Help({ field }) {
  return field.help ? <div className="help">{field.help}</div> : null;
}

function IdPicker({ field, value, onChange, focusRef }) {
  const { guildData } = useEditor();
  const { channels, roles } = guildData;
  let options = [];
  let prefix = '';
  if (field.kind === 'channel') { options = channels.filter((c) => c.type !== 'GuildCategory'); prefix = '#'; }
  else if (field.kind === 'category') { options = channels.filter((c) => c.type === 'GuildCategory'); }
  else if (field.kind === 'role') { options = [{ id: '@everyone', name: 'everyone' }, ...roles]; prefix = '@'; }
  else if (field.kind === 'form') { options = (guildData.forms || []).map((f) => ({ id: f.key, name: f.label })); }
  else if (field.kind.endsWith('-account')) { options = guildData.accounts?.[field.kind.replace('-account', '')] ?? []; } // the Twitch / TikTok accounts connected to this server
  const match = options.find((o) => o.id === value);
  return (
    <>
      <div className="idfield">
        <input
          type="text" value={value ?? ''} placeholder={field.placeholder || (field.kind === 'user' ? 'user ID or {{user.id}}' : field.kind === 'form' ? 'pick a form →' : `${field.kind} ID or name`)}
          onChange={(e) => onChange(e.target.value)} onFocus={track(focusRef, onChange)} spellCheck={false}
        />
        {options.length > 0 && (
          <select aria-label={`Pick ${field.kind}`} value="" onChange={(e) => e.target.value && onChange(e.target.value)}>
            <option value="">Pick…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{prefix}{o.name}</option>)}
          </select>
        )}
      </div>
      {match && <div className="help">→ {prefix}{match.name}</div>}
    </>
  );
}

/** A picture: chosen from the server's uploads (`upload:<id>`), or typed as an https link (flows may also use {{variables}}). */
function ImageField({ field, value, onChange, focusRef, id }) {
  const { gid, openLibrary } = useImages();
  const [broken, setBroken] = useState(null); // the picture id that failed to load
  const picked = uploadIdOf(value);
  const choose = () => openLibrary({ current: value, onPick: onChange });
  if (picked && gid) {
    return (
      <div className="imagefield">
        {broken === picked
          ? <span className="img-thumb missing" role="img" aria-label="Missing picture">?</span>
          : <img className="img-thumb" src={uploadPath(gid, picked)} alt="" onError={() => setBroken(picked)} />}
        <div className="imagefield-info">
          <span className="tiny">{broken === picked ? 'This picture was deleted.' : 'Uploaded picture'}</span>
          <span className="row">
            <button type="button" className="btn small" onClick={choose}>{broken === picked ? 'Choose another…' : 'Change…'}</button>
            <button type="button" className="btn small ghost" onClick={() => onChange('')}>Remove</button>
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="idfield">
      <input
        id={id} type="text" value={value ?? ''} placeholder={field.placeholder || 'https://… or choose a picture'}
        onChange={(e) => onChange(e.target.value)} onFocus={track(focusRef, onChange)} spellCheck={false}
      />
      <button type="button" className="btn small" disabled={!gid} onClick={choose}>Choose…</button>
    </div>
  );
}

function MultiSelect({ field, value, onChange }) {
  const set = new Set(Array.isArray(value) ? value : []);
  const toggle = (v) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); onChange([...n]); };
  return (
    <div className="chips" role="group" aria-label={field.label}>
      {field.options.map((o) => (
        <button key={o.value} type="button" className={`chip ${set.has(o.value) ? 'on' : ''}`} aria-pressed={set.has(o.value)} onClick={() => toggle(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ListField({ field, value, onChange, focusRef }) {
  const { guildData } = useEditor();
  const names = namesFor(guildData);
  const items = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState(() => new Set(items.length <= 2 ? items.map((_, i) => i) : []));
  const toggle = (i) => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const update = (i, key, v) => onChange(items.map((it, idx) => (idx === i ? { ...it, [key]: v } : it)));
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = () => { onChange([...items, field.item.create()]); setOpen((s) => new Set(s).add(items.length)); };
  return (
    <div className="list">
      {items.map((item, i) => (
        <div className="list-item" key={item.id ?? i}>
          <div className="list-head">
            <button type="button" className="list-title" aria-expanded={open.has(i)} onClick={() => toggle(i)}>
              <span className="caret">{open.has(i) ? '▾' : '▸'}</span>
              {String(field.item.label?.(item, names) || `Item ${i + 1}`).slice(0, 40)}
            </button>
            <span className="list-actions">
              <button type="button" className="icon-btn" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="icon-btn" title="Move down" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="icon-btn danger" title="Remove" aria-label="Remove" onClick={() => remove(i)}>✕</button>
            </span>
          </div>
          {open.has(i) && (
            <div className="list-body">
              <FieldList fields={field.item.fields} data={item} onChange={(k, v) => update(i, k, v)} focusRef={focusRef} />
            </div>
          )}
        </div>
      ))}
      <button type="button" className="btn small" disabled={items.length >= (field.max ?? Infinity)} onClick={add}>+ Add</button>
    </div>
  );
}

export default function FieldEditor({ field, value, onChange, focusRef }) {
  const id = `f-${field.key}`;
  let control;
  switch (field.type) {
    case 'text':
      control = <input id={id} type="text" value={value ?? ''} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} onFocus={track(focusRef, onChange)} spellCheck={false} />;
      break;
    case 'textarea':
      control = <textarea id={id} rows={field.rows ?? 3} value={value ?? ''} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} onFocus={track(focusRef, onChange)} />;
      break;
    case 'number':
      control = (
        <input
          id={id} type="number" value={value ?? ''} min={field.min} max={field.max} step="any" placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      );
      break;
    case 'boolean':
      return (
        <div className="field check">
          <label htmlFor={id}>
            <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
            <span>{field.label}</span>
          </label>
          <Help field={field} />
        </div>
      );
    case 'select':
      control = (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {field.open && value && !field.options.some((o) => o.value === value) && <option value={value}>{value}</option>}
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'multiselect': control = <MultiSelect field={field} value={value} onChange={onChange} />; break;
    case 'color':
      control = (
        <div className="colorfield">
          <input id={id} type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#5865f2'} onChange={(e) => onChange(e.target.value)} />
          <input type="text" aria-label={`${field.label} (hex)`} value={value ?? ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
        </div>
      );
      break;
    case 'id': control = <IdPicker field={field} value={value} onChange={onChange} focusRef={focusRef} />; break;
    case 'image': control = <ImageField field={field} value={value} onChange={onChange} focusRef={focusRef} id={id} />; break;
    case 'list': control = <ListField field={field} value={value} onChange={onChange} focusRef={focusRef} />; break;
    default: control = null;
  }
  return (
    <div className="field">
      <label htmlFor={id}>{field.label}{field.required && <span className="req" title="Required"> *</span>}</label>
      {control}
      <Help field={field} />
    </div>
  );
}
