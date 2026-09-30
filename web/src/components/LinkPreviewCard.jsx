import { useMemo } from 'react';
import { pageMeta } from '@shared/page-meta.js';

/** A small mock of the card Discord shows when this page's link is pasted, built from the same data as the real <meta> tags. */
export default function LinkPreviewCard({ page, guild }) {
  const meta = useMemo(
    () => pageMeta(page, { guild, baseUrl: window.location.origin }),
    [page, guild],
  );
  return (
    <figure className="link-card" style={{ '--edge': meta.color }} aria-label="How the link looks in Discord">
      <div className="lc-text">
        <div className="lc-site">{meta.siteName}</div>
        <div className="lc-title">{meta.title}</div>
        {meta.description && <div className="lc-desc">{meta.description}</div>}
      </div>
      {meta.image && <img className={`lc-img ${meta.card === 'summary' ? 'thumb' : 'wide'}`} src={meta.image} alt="" />}
    </figure>
  );
}
