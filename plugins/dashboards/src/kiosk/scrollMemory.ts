/*
 * The scroll position of the kiosk survives a reload of the page. A self reload into a new plugin
 * version (see resilience/connection.ts) keeps the tab, because the tab is in the URL, and this
 * keeps the scroll position, which is not. The position is kept per dashboard and tab in
 * sessionStorage, which lives as long as the browser tab and goes with it. It is restored once,
 * when the content is tall enough, because the widgets grow the page as their data arrives.
 */
import React from 'react';

export const SCROLL_KEY = 'dashboards.kiosk.scroll';
/** How long a restore waits for the content to grow to the saved position. */
export const RESTORE_WINDOW_MS = 4_000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const keyOf = (id: string): string => `${SCROLL_KEY}:${id}`;

export function saveScroll(store: Store | undefined, id: string, top: number): void {
  try {
    store?.setItem(keyOf(id), String(Math.max(0, Math.round(top))));
  } catch {
    // A blocked store: the position is not kept.
  }
}

export function loadScroll(store: Store | undefined, id: string): number {
  try {
    const n = Number(store?.getItem(keyOf(id)));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Keeps the scroll position of `el` under `id`, and restores it once after a reload. An empty `id` does nothing. */
export function useScrollMemory(el: HTMLElement | null, id: string): void {
  React.useEffect(() => {
    if (!el || id === '') return undefined;
    let store: Store | undefined;
    try {
      store = window.sessionStorage;
    } catch {
      store = undefined;
    }
    const wanted = loadScroll(store, id);
    // The position is saved only after the restore is over, so the first empty page never overwrites it.
    let restoring = wanted > 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      restoring = false;
      if (timer) clearTimeout(timer);
    };
    const tryRestore = () => {
      if (!restoring) return;
      if (el.scrollHeight - el.clientHeight >= wanted) {
        el.scrollTop = wanted;
        done();
      }
    };
    const observer =
      typeof ResizeObserver === 'function' && el.firstElementChild
        ? new ResizeObserver(tryRestore)
        : undefined;
    if (restoring) {
      if (el.firstElementChild) observer?.observe(el.firstElementChild);
      tryRestore();
      timer = setTimeout(done, RESTORE_WINDOW_MS);
    }
    const onScroll = () => {
      if (restoring) {
        // The user scrolled before the restore: the user wins.
        if (Math.abs(el.scrollTop - wanted) > 2 && el.scrollTop > 0) done();
        else return;
      }
      saveScroll(store, id, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      done();
    };
  }, [el, id]);
}
