import { useEffect, useState } from 'react';

/** A phone-sized screen. Keep in step with the `max-width: 720px` block in styles.css. */
export const PHONE = '(max-width: 720px)';

const read = (query) => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
export const matches = read;

/** Whether `query` (a CSS media query) currently matches, kept up to date when the window is resized or turned. */
export function useMediaQuery(query) {
  const [now, setNow] = useState(() => read(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(query);
    const on = () => setNow(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return now;
}
