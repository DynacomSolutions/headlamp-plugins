/*
 * Fit to screen height: the grid rows of a tab stretch so its widgets fill the height left under
 * the title bar and above the footer. The maths is pure (`fitRowHeight`) and the hook only
 * measures and feeds it. The row height never goes below the fixed one, so a small screen
 * scrolls instead of squashing the widgets, and it never goes above a cap, so a tab with one
 * short row does not make a giant widget.
 */
import React from 'react';
import { ROW_HEIGHT, rowsUsed } from './layout';
import type { Section } from './spec/model';

export const MIN_FILL_ROW_HEIGHT = ROW_HEIGHT;
export const MAX_FILL_ROW_HEIGHT = 240;
/**
 * The content may be this many px shorter than the space and stay as it is. It must never be
 * taller, because that makes a scrollbar for 1 px. The window also stops a loop caused by rounding.
 */
export const FILL_TOLERANCE_PX = 3;
/** The fit aims this far short of the space, in the middle of the window above. */
const FILL_AIM_PX = 1.5;
/** At most this many changes in a row without an outside trigger (resize, tab, mode). */
const MAX_STEPS = 8;

/**
 * The row height that makes the content fill the available height.
 * - `current`: the row height now.
 * - `rows`: the grid rows that scale with the row height (the sum over the sections of the tab).
 * - `available`: the height the content may use, in px.
 * - `used`: the height the content uses now, at `current`, in px.
 * Each row adds exactly one `current` step to the content height, so the change is linear.
 * Returns `current` when there is nothing to scale or the content already fits within the
 * tolerance (not taller than the space, and at most `FILL_TOLERANCE_PX` shorter).
 */
export function fitRowHeight(args: {
  current: number;
  rows: number;
  available: number;
  used: number;
  min?: number;
  max?: number;
}): number {
  const { current, rows, available, used } = args;
  const min = args.min ?? MIN_FILL_ROW_HEIGHT;
  const max = args.max ?? MAX_FILL_ROW_HEIGHT;
  if (rows <= 0 || !Number.isFinite(available) || !Number.isFinite(used) || available <= 0) {
    return Math.min(max, Math.max(min, current));
  }
  const gap = available - used;
  const inside = gap >= 0 && gap <= FILL_TOLERANCE_PX;
  const target = inside ? current : current + (gap - FILL_AIM_PX) / rows;
  // One decimal is fine enough: 0.1 px of row height is a few px over a whole tab.
  return Math.round(Math.min(max, Math.max(min, target)) * 10) / 10;
}

/**
 * The grid rows that grow with the row height: all the rows of the tab. A self-scroll section
 * counts too. While a tab fits the screen, its fixed pixel height gives way to the grid height,
 * because the fixed height is what leaves the empty band under the grid.
 */
export const scalableRows = (sections: ReadonlyArray<Section>): number =>
  sections.reduce((n, s) => n + rowsUsed(s.widgets), 0);

function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.hasAttribute('data-kiosk-scroll')) return p;
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.clientHeight > 0) return p;
  }
  return null;
}

const px = (v: string): number => Number.parseFloat(v) || 0;

/**
 * Height in px left for the content under its top edge, down to the bottom of the scrolling area.
 * The footer, and the bottom padding of the page and of the scroller, are not available.
 */
function measure(el: HTMLElement): { available: number; used: number } | null {
  const scroller = scrollParentOf(el);
  const viewport = scroller ? scroller.clientHeight : window.innerHeight;
  if (!viewport) return null;
  const rect = el.getBoundingClientRect();
  const base = scroller ? scroller.getBoundingClientRect().top : 0;
  const scrolled = scroller ? scroller.scrollTop : window.scrollY;
  const top = rect.top - base + scrolled;
  let below = scroller ? px(getComputedStyle(scroller).paddingBottom) : 0;
  const page = el.closest<HTMLElement>('[data-dashboard-page]');
  if (page) below += px(getComputedStyle(page).paddingBottom);
  const root = page ?? el.ownerDocument;
  const footer = root.querySelector<HTMLElement>('[data-band="footer"]');
  if (footer) below += footer.offsetHeight;
  // No height yet: the grid has not got its width. The content observer calls again when it has.
  if (el.offsetHeight <= 0) return null;
  return { available: viewport - top - below, used: el.offsetHeight };
}

/**
 * The row height for a tab, and the ref for the element that holds its sections. It measures
 * after a render and on a resize of the scroller, the window, the content or the footer, and on a
 * full screen change. Each change of the row height re-measures, until the gap is within the
 * tolerance or `MAX_STEPS` changes were made without an outside trigger.
 */
export function useFillRowHeight(
  enabled: boolean,
  rows: number,
  /** A new value (tab id, kiosk) restarts the fit. */
  resetKey: string
): { ref: (el: HTMLDivElement | null) => void; rowHeight: number } {
  // A callback ref in state: the element can mount later than the first render with the setting
  // on (for example after a loader), and the effect then starts when it arrives.
  const [el, ref] = React.useState<HTMLDivElement | null>(null);
  const [fitted, setFitted] = React.useState(ROW_HEIGHT);
  const current = React.useRef(ROW_HEIGHT);
  current.current = enabled ? fitted : ROW_HEIGHT;
  // True from a change of the row height until React has drawn it. A measure in between would
  // see the old height and add its step twice.
  const pending = React.useRef(false);
  const again = React.useRef<(() => void) | null>(null);

  React.useLayoutEffect(() => {
    if (!enabled || !el || rows <= 0) {
      // Back to the fixed height, so a later fit starts from what is on screen.
      setFitted(ROW_HEIGHT);
      return undefined;
    }
    let steps = 0;
    pending.current = false;
    const run = () => {
      if (pending.current) return;
      const m = measure(el);
      if (!m) return;
      const next = fitRowHeight({ current: current.current, rows, ...m });
      if (next === current.current) return;
      steps += 1;
      if (steps > MAX_STEPS) return;
      current.current = next;
      pending.current = true;
      setFitted(next);
    };
    again.current = run;
    const outside = () => {
      steps = 0;
      run();
    };
    run();
    const win = el.ownerDocument.defaultView;
    win?.addEventListener('resize', outside);
    el.ownerDocument.addEventListener('fullscreenchange', outside);
    let observer: ResizeObserver | undefined;
    let grid: ResizeObserver | undefined;
    if (typeof ResizeObserver === 'function') {
      // The scroller, the page and the footer follow the screen, not our own change of the
      // rows, so each call of this one is an outside trigger.
      observer = new ResizeObserver(outside);
      // The content itself: its height changes with our rows and when the grid first gets its
      // width. That call is not an outside trigger, so it counts against MAX_STEPS.
      grid = new ResizeObserver(run);
      grid.observe(el);
      const scroller = scrollParentOf(el);
      if (scroller) observer.observe(scroller);
      observer.observe(el.ownerDocument.documentElement);
      const footer = el.ownerDocument.querySelector('[data-band="footer"]');
      if (footer) observer.observe(footer);
    }
    return () => {
      again.current = null;
      win?.removeEventListener('resize', outside);
      el.ownerDocument.removeEventListener('fullscreenchange', outside);
      observer?.disconnect();
      grid?.disconnect();
    };
    // `resetKey` restarts the fit on a tab or mode change.
  }, [el, enabled, rows, resetKey]);

  // The new height is on screen: measure again, to see whether it fits.
  React.useLayoutEffect(() => {
    pending.current = false;
    again.current?.();
  }, [fitted]);

  return { ref, rowHeight: enabled ? fitted : ROW_HEIGHT };
}
