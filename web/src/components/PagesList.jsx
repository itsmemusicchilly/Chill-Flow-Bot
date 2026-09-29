export default function PagesList({ pages, pageId, limit, onOpen, onNew, onDuplicate, onRemove }) {
  const copy = (p) => navigator.clipboard?.writeText(p.url);
  return (
    <div className="flow-list">
      <button className="btn primary block" onClick={onNew}>+ New page</button>
      {pages.length === 0 && <p className="muted tiny">No pages yet. Pages are little websites for your community — a landing page, an application form, the rules…</p>}
      {pages.map((p) => (
        <div key={p.id} className={`flow-item ${p.id === pageId ? 'active' : ''}`}>
          <button className="flow-open" onClick={() => onOpen(p.id)}>
            <span className={`dot ${p.published ? 'on' : ''}`} title={p.published ? 'Published' : 'Not published'} />
            <span className="flow-title">{p.title}</span>
            {p.issues > 0 && <span className="badge bad" title={`${p.issues} thing(s) to fix`}>{p.issues}</span>}
          </button>
          <span className="flow-actions">
            {p.published && <button className="icon-btn" title="Copy public link" aria-label={`Copy link to ${p.title}`} onClick={() => copy(p)}>🔗</button>}
            <button className="icon-btn" title="Duplicate" aria-label={`Duplicate ${p.title}`} onClick={() => onDuplicate(p)}>⧉</button>
            <button className="icon-btn danger" title="Delete" aria-label={`Delete ${p.title}`} onClick={() => onRemove(p)}>🗑</button>
          </span>
        </div>
      ))}
      <p className="tiny muted">{pages.length}{limit ? `/${limit}` : ''} {pages.length === 1 ? 'page' : 'pages'}</p>
    </div>
  );
}
