/*
 * Swipe right from the left edge to go Back, on every Headlamp page. It does what the browser Back
 * button does, for the installed web app that has no such button. A hint follows the finger. The
 * rules that keep it away from sideways scroll and text selection are in swipe.ts. On a desktop
 * Alt+Left still works, as the browser handles it.
 */
import { blocksSwipe, SwipeTracker } from './swipe';
import { showSwipeHint, SwipeHint } from './swipeHint';

export interface EdgeBackOptions {
  /** What Back does. The default is `history.back()`. */
  goBack?: () => void;
}

/** Installs the listeners on the window. Returns a function that removes them. */
export function installEdgeBack(win: Window = window, options: EdgeBackOptions = {}): () => void {
  const goBack = options.goBack ?? (() => win.history.back());
  const doc = win.document;
  const tracker = new SwipeTracker('edge');
  let hint: SwipeHint | null = null;

  const stop = () => {
    tracker.cancel();
    hint?.remove();
    hint = null;
    doc.removeEventListener('selectionchange', stop);
  };

  const onStart = (e: TouchEvent) => {
    stop();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (blocksSwipe(e.target, 'edge', win)) return;
    if (!tracker.begin({ x: t.clientX, y: t.clientY, t: e.timeStamp })) return;
    doc.addEventListener('selectionchange', stop);
  };

  const onMove = (e: TouchEvent) => {
    if (!tracker.active) return;
    if (e.touches.length !== 1) {
      stop();
      return;
    }
    const t = e.touches[0];
    const m = tracker.move({ x: t.clientX, y: t.clientY, t: e.timeStamp });
    if (!m.live) {
      stop();
      return;
    }
    if (m.dx < 8) return;
    hint ??= showSwipeHint('left', 'Back', doc);
    hint.update(m.progress, m.dx);
  };

  const onEnd = (e: TouchEvent) => {
    if (!tracker.active) return;
    const t = e.changedTouches[0];
    const result = t ? tracker.end({ x: t.clientX, y: t.clientY, t: e.timeStamp }) : null;
    stop();
    if (result?.type === 'back') goBack();
  };

  doc.addEventListener('touchstart', onStart, { passive: true });
  doc.addEventListener('touchmove', onMove, { passive: true });
  doc.addEventListener('touchend', onEnd, { passive: true });
  doc.addEventListener('touchcancel', stop, { passive: true });
  return () => {
    stop();
    doc.removeEventListener('touchstart', onStart);
    doc.removeEventListener('touchmove', onMove);
    doc.removeEventListener('touchend', onEnd);
    doc.removeEventListener('touchcancel', stop);
  };
}
