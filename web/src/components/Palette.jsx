import { useMemo, useState } from 'react';
import { CATEGORIES, NODE_LIST } from '@shared/catalog.js';

export default function Palette({ onAdd, intents }) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.entries(CATEGORIES).map(([key, cat]) => ({
      key, cat,
      nodes: NODE_LIST.filter((d) => d.category === key && (!q || `${d.label} ${d.description}`.toLowerCase().includes(q))),
    })).filter((g) => g.nodes.length);
  }, [query]);

  return (
    <div className="palette">
      <input type="search" className="search" placeholder="Search nodes…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search nodes" />
      <p className="tiny muted">Click a node to add it, or drag it onto the canvas.</p>
      {groups.map(({ key, cat, nodes }) => (
        <section key={key} aria-label={cat.label}>
          <h3 style={{ '--cat': cat.color }}>{cat.label}<span>{cat.blurb}</span></h3>
          <div className="palette-list">
            {nodes.map((d) => {
              const blocked = d.requires && !intents[d.requires];
              return (
                <button
                  key={d.type} type="button" className={`palette-item ${blocked ? 'blocked' : ''}`} style={{ '--cat': cat.color }}
                  draggable onDragStart={(e) => { e.dataTransfer.setData('application/flowbot-node', d.type); e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={() => onAdd(d.type)} title={blocked ? `${d.description}\n\nDisabled by the bot operator (needs the ${d.requires === 'members' ? 'Server Members' : 'Message Content'} intent).` : d.description}
                >
                  <span className="pi-ico" aria-hidden="true">{d.icon}</span>
                  <span className="pi-label">{d.label}</span>
                  {blocked && <span className="pi-lock" aria-label="Unavailable">🔒</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {!groups.length && <p className="muted">Nothing matches “{query}”.</p>}
    </div>
  );
}
