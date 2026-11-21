/*
 * Swipe left or right on the tab area of a dashboard to go to the next or the previous tab. Each
 * tab change is a history push (the caller does it), so Back returns to the tab before. The
 * rules that keep it away from sideways scroll and text selection are in swipe.ts. The first tab
 * has no previous one and the last has no next one: the swipe then does nothing. The Back swipe
 * from the left edge is separate (see edgeBack.ts), so a tab swipe never starts in the edge zone.
 */
import React from 'react';
import { blocksSwipe, SwipeTracker } from './swipe';
import { showSwipeHint, SwipeHint } from './swipeHint';

export interface TabSwipeOptions {
  /** Off while a dashboard is edited, because dragging a widget uses touch too. */
  enabled: boolean;
  /** The tab to go to for a step: +1 is the next tab. Returns false when there is none. */
  canStep: (step: 1 | -1) => boolean;
  onStep: (step: 1 | -1) => void;
}

export function useTabSwipe(area: HTMLElement | null, options: TabSwipeOptions): void {
  const latest = React.useRef(options);
  latest.current = options;
  const { enabled } = options;

  React.useEffect(() => {
    if (!area || !enabled) return undefined;
    const doc = area.ownerDocument;
    const win = doc.defaultView ?? window;
    const tracker = new SwipeTracker('tab');
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
      if (blocksSwipe(e.target, 'tab', win, area)) return;
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
      const step = m.dx < 0 ? 1 : -1;
      if (Math.abs(m.dx) < 16 || !latest.current.canStep(step)) return;
      hint ??= showSwipeHint(
        step === 1 ? 'right' : 'left',
        step === 1 ? 'Next tab' : 'Previous tab',
        doc
      );
      hint.update(m.progress, m.dx);
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracker.active) return;
      const t = e.changedTouches[0];
      const result = t ? tracker.end({ x: t.clientX, y: t.clientY, t: e.timeStamp }) : null;
      stop();
      if (result?.type === 'tab' && latest.current.canStep(result.step))
        latest.current.onStep(result.step);
    };

    area.addEventListener('touchstart', onStart, { passive: true });
    area.addEventListener('touchmove', onMove, { passive: true });
    area.addEventListener('touchend', onEnd, { passive: true });
    area.addEventListener('touchcancel', stop, { passive: true });
    return () => {
      stop();
      area.removeEventListener('touchstart', onStart);
      area.removeEventListener('touchmove', onMove);
      area.removeEventListener('touchend', onEnd);
      area.removeEventListener('touchcancel', stop);
    };
  }, [area, enabled]);
}
