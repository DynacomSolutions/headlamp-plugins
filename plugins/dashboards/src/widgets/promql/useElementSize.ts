import React from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * The size of an element, kept up to date with a ResizeObserver. `ref` always holds the latest
 * size, so a fetch can read the width without depending on it (a resize never refetches).
 * `measured` turns true once, after the first measurement.
 */
export function useElementSize<T extends HTMLElement>(): {
  ref: React.RefObject<T>;
  size: ElementSize;
  sizeRef: React.MutableRefObject<ElementSize>;
  measured: boolean;
} {
  const ref = React.useRef<T>(null);
  const sizeRef = React.useRef<ElementSize>({ width: 0, height: 0 });
  const [size, setSize] = React.useState<ElementSize>({ width: 0, height: 0 });
  const [measured, setMeasured] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = (w: number, h: number) => {
      const next = { width: Math.round(w), height: Math.round(h) };
      sizeRef.current = next;
      setSize(prev => (prev.width === next.width && prev.height === next.height ? prev : next));
      if (next.width > 0) setMeasured(true);
    };
    apply(el.clientWidth, el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) apply(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size, sizeRef, measured };
}
