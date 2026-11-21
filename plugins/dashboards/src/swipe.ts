/*
 * Touch swipes. The app runs as an installed web app with no browser Back button, so a swipe has
 * to do what Back does.
 *
 *   edge swipe   a finger starts in the left edge zone and moves right: Back in Headlamp history.
 *                It works on every Headlamp page (see edgeBack.ts).
 *   tab swipe    a finger starts inside the dashboard and moves left (next tab) or right (previous
 *                tab). It works on the tab area of a dashboard only (see useTabSwipe.ts).
 *
 * A swipe must not fight the page. A gesture is dropped when:
 *   - a second finger touches the screen;
 *   - the text is selected, or the selection changes during the gesture;
 *   - the finger starts on a text field, a slider, or an element marked `data-no-swipe`;
 *   - the finger starts inside an element that scrolls sideways (a wide table). For the edge swipe
 *     that holds only when the element is scrolled away from its left end, so the edge swipe
 *     still works when it is at the left end;
 *   - the move is more up and down than sideways, or it is too short, or too slow.
 * This file has no DOM listener of its own, so the rules are easy to test.
 */

/** The width of the left edge zone, in pixels. */
export const EDGE_ZONE = 24;
/** The sideways travel that completes a Back swipe, in pixels. */
export const BACK_DISTANCE = 80;
/** The sideways travel that completes a tab swipe, in pixels. */
export const TAB_DISTANCE = 72;
/** Sideways travel must be at least this many times the up and down travel. */
export const AXIS_RATIO = 1.6;
/** The longest time of a swipe, in milliseconds. */
export const MAX_DURATION = 900;
/** The travel after which the direction is clear, in pixels. */
const LOCK_DISTANCE = 12;

export type SwipeMode = 'edge' | 'tab';

export interface SwipePoint {
  x: number;
  y: number;
  t: number;
}

export type SwipeResult = { type: 'back' } | { type: 'tab'; step: 1 | -1 } | null;

export interface SwipeMove {
  /** True while the gesture can still complete. */
  live: boolean;
  /** Signed sideways travel, in pixels. */
  dx: number;
  /** 0 to 1: how close the gesture is to completion. */
  progress: number;
}

const distanceOf = (mode: SwipeMode): number => (mode === 'edge' ? BACK_DISTANCE : TAB_DISTANCE);

export class SwipeTracker {
  private origin: SwipePoint | null = null;

  constructor(readonly mode: SwipeMode) {}

  get active(): boolean {
    return this.origin !== null;
  }

  /** Starts a gesture. Returns false when the point is not a place where this mode starts. */
  begin(p: SwipePoint): boolean {
    const inEdge = p.x <= EDGE_ZONE;
    if ((this.mode === 'edge') !== inEdge) return false;
    this.origin = p;
    return true;
  }

  cancel(): void {
    this.origin = null;
  }

  /** The state of the gesture for a finger position. A gesture that turns vertical ends. */
  move(p: SwipePoint): SwipeMove {
    const o = this.origin;
    if (!o) return { live: false, dx: 0, progress: 0 };
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const wrongWay = this.mode === 'edge' && dx < 0;
    const travel = Math.max(Math.abs(dx), Math.abs(dy));
    const vertical = travel >= LOCK_DISTANCE && Math.abs(dx) < Math.abs(dy) * AXIS_RATIO;
    if (wrongWay || vertical || p.t - o.t > MAX_DURATION) {
      this.origin = null;
      return { live: false, dx, progress: 0 };
    }
    return { live: true, dx, progress: Math.min(1, Math.abs(dx) / distanceOf(this.mode)) };
  }

  /** The result at the end of the gesture. */
  end(p: SwipePoint): SwipeResult {
    const o = this.origin;
    this.origin = null;
    if (!o) return null;
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    if (p.t - o.t > MAX_DURATION) return null;
    if (Math.abs(dx) < distanceOf(this.mode)) return null;
    if (Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) return null;
    if (this.mode === 'edge') return dx > 0 ? { type: 'back' } : null;
    return { type: 'tab', step: dx < 0 ? 1 : -1 };
  }
}

/** An element that takes sideways touch for itself. */
function takesTouch(el: Element): boolean {
  if (el.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
    return true;
  return el.matches('[data-no-swipe], [role="slider"]');
}

function scrollsSideways(el: Element, win: Window): boolean {
  const overflow = win.getComputedStyle(el).overflowX;
  return (overflow === 'auto' || overflow === 'scroll') && el.scrollWidth > el.clientWidth + 1;
}

/** True when the selection holds text. A swipe then belongs to the selection. */
export function hasSelection(win: Window = window): boolean {
  const sel = win.getSelection?.();
  return !!sel && !sel.isCollapsed && sel.toString() !== '';
}

/**
 * True when a swipe that starts on `target` must be left to the page. `root` stops the search, so
 * only elements inside it count. Without it the search goes up to the document.
 */
export function blocksSwipe(
  target: EventTarget | null,
  mode: SwipeMode,
  win: Window = window,
  root?: Element | null
): boolean {
  if (hasSelection(win)) return true;
  let el: Element | null = target instanceof Element ? target : null;
  while (el) {
    if (takesTouch(el)) return true;
    if (scrollsSideways(el, win) && (mode === 'tab' || el.scrollLeft > 0)) return true;
    if (el === root) break;
    el = el.parentElement;
  }
  return false;
}
