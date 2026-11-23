import React from 'react';

/**
 * The width of an element in px, kept up to date with a ResizeObserver on that element. It is null
 * until the first measure, and stays null where there is no ResizeObserver. A caller then draws the
 * wide layout. A widget needs this, not the window width: the same window holds a wide and a narrow
 * widget side by side.
 */
export function useElementWidth<T extends HTMLElement>(): {
  ref: React.RefObject<T>;
  width: number | null;
} {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState<number | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      setWidth(prev => (prev === w ? prev : w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}
