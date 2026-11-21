/*
 * The hint that follows the finger during a swipe: a round chip with an arrow that slides in from
 * the screen edge. It grows with the travel and turns bright when the swipe will complete. It
 * ignores the pointer and is hidden from screen readers.
 */
export type HintSide = 'left' | 'right';

const SIZE = 44;
const REACH = 56;

export interface SwipeHint {
  /** `progress` is 0 to 1. */
  update(progress: number, dx: number): void;
  remove(): void;
}

export function showSwipeHint(side: HintSide, label: string, doc: Document = document): SwipeHint {
  const el = doc.createElement('div');
  el.setAttribute('data-swipe-hint', side);
  el.setAttribute('aria-hidden', 'true');
  const arrow = side === 'left' ? '‹' : '›';
  el.textContent = arrow;
  el.title = label;
  Object.assign(el.style, {
    position: 'fixed',
    top: '50%',
    [side]: '0',
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '30px',
    lineHeight: '1',
    color: '#fff',
    background: 'rgba(25, 25, 25, 0.88)',
    border: '2px solid rgba(255, 255, 255, 0.35)',
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.4)',
    pointerEvents: 'none',
    zIndex: '2000',
    opacity: '0',
    transform: 'translate(0, -50%)',
  } as Partial<CSSStyleDeclaration>);
  doc.body.appendChild(el);
  const sign = side === 'left' ? 1 : -1;
  return {
    update(progress, dx) {
      const shift = Math.min(REACH, Math.abs(dx) * 0.7);
      el.style.transform = `translate(${sign * (shift - SIZE)}px, -50%)`;
      el.style.opacity = String(Math.min(1, 0.25 + progress));
      const ready = progress >= 1;
      el.style.borderColor = ready ? '#fff' : 'rgba(255, 255, 255, 0.35)';
      el.setAttribute('data-ready', ready ? 'true' : 'false');
    },
    remove() {
      el.remove();
    },
  };
}
