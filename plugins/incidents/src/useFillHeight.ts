import React from 'react';

/** Space below an element that its ancestors keep (padding, border, margin). */
function spaceBelow(el: HTMLElement): number {
  let total = 0;
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
    const cs = window.getComputedStyle(n);
    total += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    if (n !== el) total += parseFloat(cs.marginBottom) || 0;
  }
  return total;
}

/**
 * Height that fills the viewport below the element's top edge, minus the space the
 * surrounding layout keeps below it. Avoids hard-coding Headlamp's chrome height.
 */
export function useFillHeight() {
  const [height, setHeight] = React.useState<number | null>(null);
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!node) return undefined;
    const measure = () => {
      const top = node.getBoundingClientRect().top;
      setHeight(Math.max(0, Math.floor(window.innerHeight - top - spaceBelow(node))));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(document.body);
    if (node.parentElement) ro?.observe(node.parentElement);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [node]);
  return { ref: setNode, height };
}
