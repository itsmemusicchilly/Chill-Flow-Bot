import { useMemo, useRef } from 'react';
import { availableVariables, CATEGORIES, NODE_TYPES } from '@shared/catalog.js';
import { useEditor } from '../context.js';
import { FieldList } from './FieldEditor.jsx';

function insertAtCaret(target, text) {
  const { el, apply } = target;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
  apply(next);
  requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(start + text.length, start + text.length); } catch { /* element gone */ } });
}

export default function Inspector({ node, nodes, edges, issues, onChange, onDuplicate, onDelete }) {
  const focusRef = useRef(null);
  const def = node ? NODE_TYPES[node.type] : null;
  const { guildData } = useEditor();
  const vars = useMemo(() => (node ? availableVariables(nodes, edges, node.id, { forms: guildData.forms }) : []), [node, nodes, edges, guildData.forms]);
  if (!node || !def) return null;
  const cat = CATEGORIES[def.category];

  const useVar = (path) => {
    const token = `{{${path}}}`;
    if (focusRef.current && document.contains(focusRef.current.el)) insertAtCaret(focusRef.current, token);
    else navigator.clipboard?.writeText(token).catch(() => {});
  };

  return (
    <aside className="inspector" aria-label="Node settings" style={{ '--cat': cat.color }}>
      <header className="insp-head">
        <span className="fnode-ico" aria-hidden="true">{def.icon}</span>
        <div>
          <h2>{def.label}</h2>
          <p className="muted tiny">{def.description}</p>
        </div>
      </header>

      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((i, k) => <li key={k} className={i.level}>{i.message}</li>)}
        </ul>
      )}

      <div className="insp-fields">
        <FieldList fields={def.fields} data={node.data} onChange={(k, v) => onChange(node.id, { [k]: v })} focusRef={focusRef} />
      </div>

      {!def.isTrigger && (
        <details className="vars">
          <summary>Variables you can use ({vars.length})</summary>
          <p className="tiny muted">Click a variable to insert it where your cursor is.</p>
          <div className="chips">
            {vars.map((v) => (
              <button key={v.path} type="button" className="chip var" title={v.label} onMouseDown={(e) => e.preventDefault()} onClick={() => useVar(v.path)}>
                {`{{${v.path}}}`}
              </button>
            ))}
          </div>
          <p className="tiny muted">Filters: <code>{'{{name | upper}}'}</code> <code>{'{{x | default:none}}'}</code></p>
        </details>
      )}

      <footer className="insp-foot">
        <button className="btn small" onClick={() => onDuplicate(node.id)}>Duplicate</button>
        <button className="btn small danger" onClick={() => onDelete(node.id)}>Delete</button>
      </footer>
    </aside>
  );
}
