import { useEffect, useRef } from 'react';

/** A small dropdown for the less common actions, so a top bar stays on one line. Closes on a click outside or on an item. */
export default function MoreMenu({ children, label = 'More ▾', className = '', ariaLabel }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current?.open && !ref.current.contains(e.target)) ref.current.open = false; };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return (
    <details className={`more-menu ${className}`.trim()} ref={ref}>
      <summary className="btn ghost small" aria-label={ariaLabel}>{label}</summary>
      <div className="more-panel" onClick={() => { ref.current.open = false; }}>{children}</div>
    </details>
  );
}
